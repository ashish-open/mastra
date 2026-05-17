/**
 * Mock data for the reconciliation pipeline — lets the workflow run end-to-end
 * in Mastra Studio without real bank/PG access.
 *
 * Replace these with real API calls in tools.ts when you wire production sources.
 */

import type { NormalizedTxn } from './types.js';

/** Internal ledger entries — what WE think happened on the date */
export function mockInternalLedger(date: string): NormalizedTxn[] {
  return [
    { sourceId: 'int_001', source: 'internal', date, amountPaise: 5_000_00,  merchantRefId: 'ord_acme_1', utr: null, description: 'Acme Corp Q1 invoice' },
    { sourceId: 'int_002', source: 'internal', date, amountPaise: 12_450_00, merchantRefId: 'ord_acme_2', utr: null, description: 'Acme Corp Q2 invoice' },
    { sourceId: 'int_003', source: 'internal', date, amountPaise: 7_500_00,  merchantRefId: 'ord_widg_1', utr: null, description: 'Widget Co payment' },
    { sourceId: 'int_004', source: 'internal', date, amountPaise: 3_200_00,  merchantRefId: 'ord_mock_1', utr: null, description: 'Mock Industries' },
    // Note: int_005 has no PG counterpart — it's an unmatched internal txn (the customer paid via cheque, our system thinks they used PG)
    { sourceId: 'int_005', source: 'internal', date, amountPaise: 2_100_00,  merchantRefId: 'ord_orph_1', utr: null, description: 'Orphan payment' },
  ];
}

/** PG settlements — what Zwitch/PG says they processed */
export function mockPGSettlements(date: string): NormalizedTxn[] {
  return [
    // 4 of these match internal 1-1
    { sourceId: 'pg_a01', source: 'pg', date, amountPaise: 5_000_00,  merchantRefId: 'ord_acme_1', settlementId: 'stl_001', utr: 'AXISN20260513001', counterparty: 'Acme Corp' },
    { sourceId: 'pg_a02', source: 'pg', date, amountPaise: 12_450_00, merchantRefId: 'ord_acme_2', settlementId: 'stl_001', utr: 'AXISN20260513001', counterparty: 'Acme Corp' },
    { sourceId: 'pg_a03', source: 'pg', date, amountPaise: 7_500_00,  merchantRefId: 'ord_widg_1', settlementId: 'stl_001', utr: 'AXISN20260513001', counterparty: 'Widget Co' },
    // int_004 has slight amount mismatch (PG charged ₹3,200.50 — typical rounding/charge issue) — fuzzy match candidate
    { sourceId: 'pg_a04', source: 'pg', date, amountPaise: 3_200_50,  merchantRefId: 'ord_mock_1', settlementId: 'stl_001', utr: 'AXISN20260513001', counterparty: 'Mock Industries Pvt Ltd' },
    // Extra PG row with no internal counterpart — PG had a txn we never recorded
    { sourceId: 'pg_a05', source: 'pg', date, amountPaise: 999_00,  merchantRefId: 'ord_ghost_1', settlementId: 'stl_001', utr: 'AXISN20260513001', counterparty: 'Ghost Order' },
  ];
}

/** Bank statement — what the bank says credited our account */
export function mockBankStatement(date: string, source: 'axis' | 'hdfc' | 'icici'): NormalizedTxn[] {
  if (source !== 'axis') return [];
  return [
    // The settlement above sums to ₹28,150.50 + ₹9.99 = ₹29,149.50 (in paise: 29_149_50)
    // Bank says they credited that, with one UTR — N:1 aggregation
    { sourceId: 'bank_001', source: 'bank', date, amountPaise: 29_149_50, utr: 'AXISN20260513001', counterparty: 'ZWITCH SETTLEMENT', description: 'NEFT credit from Zwitch' },
    // Another deposit not matching anything in PG — a wire transfer from a customer
    { sourceId: 'bank_002', source: 'bank', date, amountPaise: 50_000_00, utr: 'HDFC20260513999', counterparty: 'Direct Customer', description: 'NEFT credit from customer wire' },
  ];
}
