/**
 * Labeled synthetic meeting transcripts for the Meeting Summarizer eval.
 *
 * Each case is one short transcript plus the action items a human reviewer
 * would expect to be extracted. The scorer measures action-item recall:
 * how many of the labeled items did the agent extract, identified by
 * owner + a fuzzy match on the task description?
 *
 * Synthetic on purpose — real meeting transcripts contain customer PII
 * (names, account IDs, amounts) and are not allowed in the repo per
 * Bank Open compliance.
 *
 * Conventions when adding cases:
 *   - Keep transcripts under ~15 lines so eval cost stays bounded.
 *   - Use first names only (Ashish, Priya, etc.) — never full identifying info.
 *   - Use ₹X,XXX, ORD-XXXXX, X@example.com style placeholders.
 *   - Include at least one "no action items" case so we can measure
 *     spurious-extraction rate later.
 */

export interface MeetingActionItem {
  /** Name of the person who took the commitment in the transcript. */
  owner: string;
  /**
   * Short task description. Scorer does a fuzzy / LLM-judged match against
   * what the agent extracted — exact wording does NOT need to match.
   */
  task: string;
}

export interface MeetingEvalCase {
  name: string;
  /** "sales" | "support" | "finance" | "engineering" | "product" | "ops" */
  meetingType: string;
  /** Plain-text transcript, speaker-prefixed lines. */
  transcript: string;
  /** What the human reviewer would expect to see as action items. */
  expectedActionItems: MeetingActionItem[];
  notes?: string;
}

export const MEETING_CASES: MeetingEvalCase[] = [
  {
    name: 'finance — month-end recon discussion',
    meetingType: 'finance',
    transcript: [
      'Ashish: We have ₹X,XXX unmatched on the Razorpay side for last month.',
      'Priya: I think most are commission-deducted Swiggy lines. Let me pull the report.',
      'Ashish: Sure. And I will check whether the bank IFSC mapping picked up the new HDFC SKU.',
      'Priya: One more thing — can you send me the May vendor list by Friday?',
      'Ashish: Yes, I will send it by Friday EOD.',
    ].join('\n'),
    expectedActionItems: [
      { owner: 'Priya', task: 'pull the Swiggy commission-deducted report' },
      { owner: 'Ashish', task: 'check HDFC SKU IFSC mapping' },
      { owner: 'Ashish', task: 'send the May vendor list by Friday' },
    ],
  },

  {
    name: 'engineering — webhook reliability post-mortem',
    meetingType: 'engineering',
    transcript: [
      'Rahul: The webhook drop yesterday was caused by the queue worker OOMing.',
      'Sneha: I will write a runbook for the OOM scenario and link it in the on-call doc.',
      'Rahul: I can add memory-usage alerting on the worker container.',
      'Sneha: We also need to retry failed deliveries — the current code drops after 3 attempts.',
      'Rahul: Let me bump that to 10 with exponential backoff. I will ship it this week.',
    ].join('\n'),
    expectedActionItems: [
      { owner: 'Sneha', task: 'write OOM runbook and link in on-call doc' },
      { owner: 'Rahul', task: 'add memory-usage alerting on worker container' },
      { owner: 'Rahul', task: 'bump webhook retry to 10 with exponential backoff' },
    ],
  },

  {
    name: 'product — pricing change discussion (no action items)',
    meetingType: 'product',
    transcript: [
      'Ankur: We are seeing higher churn on the Starter plan.',
      'Vidya: Do you think reducing the price would help?',
      'Ankur: Hard to say. Might just lower revenue without helping retention.',
      'Vidya: We should look at the data more closely before deciding.',
      'Ankur: Agreed, let us revisit after the next billing cycle.',
    ].join('\n'),
    expectedActionItems: [],
    notes: 'Discussion only. Vague "we should look at data" is not a real commitment.',
  },

  {
    name: 'support — escalation call with named customer',
    meetingType: 'support',
    transcript: [
      'Manager: Customer (account ending 1234) is reporting failed payouts since Monday.',
      'Engineer: I will pull the payout logs for that account and check the error pattern.',
      'Manager: Please share findings by 4pm today.',
      'Engineer: Yes, by 4pm.',
      'Manager: I will draft the customer reply once you confirm root cause.',
    ].join('\n'),
    expectedActionItems: [
      { owner: 'Engineer', task: 'pull payout logs for account ending 1234, share by 4pm' },
      { owner: 'Manager', task: 'draft customer reply after root cause confirmation' },
    ],
  },
];
