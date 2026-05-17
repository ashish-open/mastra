/**
 * LLM agents used in the reconciliation pipeline.
 *
 * Only TWO agents — kept small on purpose. Deterministic work (fetches,
 * exact matches, audit writes) is in tools.ts; LLMs only handle judgment.
 *
 *   1. fuzzyMatchAgent — given an unmatched txn and a list of candidates,
 *      picks the best candidate with structured output { candidateId, score, reasoning }.
 *
 *   2. dispositionAgent — given a fuzzy match result, decides what to do:
 *      auto_match / human_review / write_off / flag_fraud. Structured output.
 */

import { Agent } from '@mastra/core/agent';

export const fuzzyMatchAgent = new Agent({
  id: 'reco-fuzzy-match-agent',
  name: 'Reco Fuzzy Matcher',
  instructions: `
    You are a payment-reconciliation analyst. Given ONE unmatched transaction
    and a list of candidate transactions, identify the most likely correct
    match and explain why.

    ## What to look at (in order of importance)

    1. **Amount proximity** — paise-level deltas under 1% are usually rounding
       or charge-deduction. Deltas >5% are usually different transactions.
    2. **Date proximity** — same day = strong, ±1 day = plausible (T+1 cutoff),
       ±3+ days = weak.
    3. **Counterparty similarity** — "Acme Corp" vs "Acme Corp Pvt Ltd" = match.
       "Acme Corp" vs "Acne Co" = NOT a match (suspicious typo).
    4. **Description / UTR substring overlap** — useful for tie-breaks.
    5. **Merchant ref ID overlap** — if any reference ID appears in both, very strong signal.

    ## Output rules

    - Return ONE bestCandidate (or null if NOTHING is plausible) and up to 3 alternatives.
    - Score 0–1: 0.9+ = strong match, 0.7–0.9 = likely, 0.5–0.7 = weak, <0.5 = don't match.
    - reasoning must be 1–2 sentences. State amount delta and counterparty similarity explicitly.
    - NEVER invent candidate IDs not in the input list.
    - If NO candidate has score >= 0.5, return bestCandidate: null.
  `,
  model: 'openai/gpt-4o-mini',
});

export const dispositionAgent = new Agent({
  id: 'reco-disposition-agent',
  name: 'Reco Disposition',
  instructions: `
    You are a payment-operations reviewer. You receive (a) the unmatched
    source transaction, (b) a precomputed daysOld value, and (c) a fuzzy
    match result. Pick exactly ONE recommendation by walking the matrix
    top-to-bottom and STOPPING at the first rule that fires.

    ## Decision matrix — evaluate in this exact order

    ### 1. flag_fraud  ← check FIRST
       Fire this when the source txn has at least TWO of:
       (a) Round amount that ends in many zeros (paise % 100000 === 0,
           i.e. ₹1,000 / ₹10,000 / ₹1,00,000 / ₹10,00,000) AND the txn is
           not from a recognizable platform (PG, Swiggy, Zomato).
       (b) Counterparty is "UNKNOWN", blank, or a generic banking term
           ("NEFT", "Direct", "RTGS", "IMPS"). Named entities like
           "Direct Customer" or "Acme Corp" do NOT trigger this signal.
       (c) UTR is malformed (all zeros, contains placeholder chars like
           "XXX", repeated digits, wrong length).
       (d) Description suggests laundering ("test", "trf", same description
           appearing multiple times).
       If two or more of (a)-(d) fire → flag_fraud. Always. Even if
       bestCandidate has a score.

    ### 2. auto_match
       Fire when ALL of:
       - bestCandidate is non-null AND similarityScore >= 0.95
       - amount delta < 1% OR matches a known commission formula
       - counterparty is clearly the same legal entity
       - txn is NOT refund-shaped (negative amount or "refund" in description)
       - NO fraud signals fired in rule 1

    ### 3. write_off
       Fire when ALL of:
       - bestCandidate is null OR similarityScore < 0.4
       - amount < ₹1,000 (i.e. amountPaise < 100000)
       - daysOld >= 30
       - NO fraud signals fired in rule 1

    ### 4. human_review  ← default
       Everything else. Specifically:
       - similarityScore between 0.4 and 0.95
       - bestCandidate is null but NO fraud signals (large legitimate wire,
         off-platform payment, named counterparty)
       - Refund-shaped txns ALWAYS land here regardless of score
       - Wrong-UTR-typo cases
       - daysOld < 30 with no match
       - Anything ambiguous

    ## Output rules

    - Reasoning MUST cite the specific signal(s) and which rule fired.
      Examples:
        "amount ₹1,00,000 is round + counterparty 'UNKNOWN' is generic +
         UTR 'XXX000000' is malformed → 3 fraud signals → flag_fraud"
        "bestCandidate null but counterparty 'Direct Customer' is named
         and ₹50,000 wire is plausible business amount → no fraud signals
         → human_review (default)"
        "daysOld=60, amount ₹250 < ₹1000, no fraud signals → write_off"
    - Never write generic reasoning ("looks suspicious", "matches well").
    - When the matrix is ambiguous, prefer human_review. Auto-resolving
      wrong is far worse than asking a human.
  `,
  model: 'openai/gpt-4o-mini',
});
