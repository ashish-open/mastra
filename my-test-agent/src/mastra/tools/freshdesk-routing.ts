/**
 * Freshdesk Routing Data — auto-generated from Freshdesk API.
 *
 * Source:
 *   GET /api/v2/admin/groups
 *   GET /api/v2/email/mailboxes
 *
 * To regenerate, run scripts/sync-freshdesk-routing.ts (or just re-run the API calls).
 */

export interface FreshdeskGroup {
  id: number;
  name: string;
}

export const FRESHDESK_GROUPS: FreshdeskGroup[] = [
  { id: 69000638831, name: 'ABC Operations' },
  { id: 69000643952, name: 'Axis Neo - NOC' },
  { id: 69000633818, name: 'CARDS_OPS' },
  { id: 69000642409, name: 'CB MBDB_HDFC' },
  { id: 69000641095, name: 'Customer Success' },
  { id: 69000638756, name: 'Flexi Operations' },
  { id: 69000438796, name: 'FR&CB_no_reply' },
  { id: 69000642403, name: 'HDFC RM Team' },
  { id: 69000643581, name: 'HDFC_PG_Reports' },
  { id: 69000428835, name: 'Integration Support' },
  { id: 69000642407, name: 'KYC MBDB_HDFC' },
  { id: 69000383382, name: 'KYC Team' },
  { id: 69000625786, name: 'KYCteam_OpenBook' },
  { id: 69000627273, name: 'L1_TRM' },
  { id: 69000642837, name: 'L2_TRM' },
  { id: 69000642408, name: 'LEA MBDB_HDFC' },
  { id: 69000635197, name: 'Lending Team' },
  { id: 69000634184, name: 'Lending Team Tech Support' },
  { id: 69000638755, name: 'LendingKart Operations' },
  { id: 69000634138, name: 'MAT_OPS' },
  { id: 69000438795, name: 'Nod_no_reply' },
  { id: 69000640497, name: 'Open Accountant' },
  { id: 69000644146, name: 'Open Capital Grievance' },
  { id: 69000644949, name: 'OpenArc Testing' },
  { id: 69000622134, name: 'OpenBook' },
  { id: 69000647123, name: 'Optotax PEG' },
  { id: 69000642927, name: 'Optotax Product Support' },
  { id: 69000640005, name: 'ORM' },
  { id: 69000644742, name: 'PEG Caramel' },
  { id: 69000633303, name: 'PEG Escalations' },
  { id: 69000642374, name: 'PEG HDFC' },
  { id: 69000646614, name: 'PEG- Recon Updates' },
  { id: 69000642406, name: 'PG MBDB_HDFC' },
  { id: 69000643580, name: 'PG_OPS_MID' },
  { id: 69000629140, name: 'PKV_no_reply' },
  { id: 69000511016, name: 'Product Development Group' },
  { id: 69000383372, name: 'Product Experience & Growth' },
  { id: 69000428825, name: 'Product Support' },
  { id: 69000637254, name: 'Product Support - Banking Stack' },
  { id: 69000642377, name: 'Product Support MBDB ( Banking )' },
  { id: 69000640768, name: 'Product Support MBDB FinanceHub' },
  { id: 69000642494, name: 'Product support Notification Group' },
  { id: 69000637475, name: 'Product Support- Banking Stack 2' },
  { id: 69000631787, name: 'PRV_no_reply' },
  { id: 69000642838, name: 'QC_TRM' },
  { id: 69000642442, name: 'Recon' },
  { id: 69000640801, name: 'Reports- Zwitch' },
  { id: 69000625784, name: 'Riskteam_OpenBook' },
  { id: 69000383381, name: 'Riskteam_OpenMoney' },
  { id: 69000447196, name: 'Settlement Team' },
  { id: 69000632916, name: 'Test - c' },
  { id: 69000632520, name: 'test CS team' },
  { id: 69000632517, name: 'Test kyc team' },
  { id: 69000632518, name: 'Test risk' },
  { id: 69000643476, name: 'Zwitch Customer Support' },
  { id: 69000640527, name: 'Zwitch Integrations' },
  { id: 69000641958, name: 'Zwitch Product Support' },
  { id: 69000574353, name: 'Zwitch Team' },
];

/** mailbox.email_config_id → default group_id (the team that owns that inbox) */
export const MAILBOX_TO_GROUP: Record<number, number> = {
  69000067571: 69000383372, // letstalk@open.money → Product Experience & Growth
  69000067572: 69000383382, // kyc@bankopen.co → KYC Team
  69000067573: 69000383381, // risk_team@bankopen.co → Riskteam_OpenMoney
  69000067574: 69000428835, // pg-support@bankopen.co → Integration Support
  69000067575: 69000438796, // disputes@bankopen.co → FR&CB_no_reply
  69000067576: 69000438795, // nodal.officer@bankopen.co → Nod_no_reply
  69000074161: 69000383372, // support@bankonnect.co → Product Experience & Growth
  69000074365: 69000383372, // letstalk@bankopen.co → Product Experience & Growth
  69000075975: 69000383372, // anish.achuthan@open.money → Product Experience & Growth
  69000096028: 69000643476, // letstalk@zwitch.io → Zwitch Customer Support
  69000103063: 69000622134, // letstalk@openbook.co → OpenBook
  69000103065: 69000625784, // riskteam@openbook.co → Riskteam_OpenBook
  69000103124: 69000625786, // kycteam@openbook.co → KYCteam_OpenBook
  69000105357: 69000383372, // letstalk@openmoney.co → Product Experience & Growth
  69000106508: 69000447196, // settlements.refunds@bankopen.co → Settlement Team
  69000110369: 69000633818, // open.cards@bankopen.co → CARDS_OPS
  69000111791: 69000428825, // product_support@bankopen.co → Product Support
  69000111792: 69000634184, // lending_support@bankopen.co → Lending Team Tech Support
  69000114188: 69000637254, // axisbank_support@bankopen.co → Product Support - Banking Stack
  69000116629: 69000635197, // creditops_blpl@bankopen.co → Lending Team
  69000117604: 69000638755, // lk.documents@bankopen.co → LendingKart Operations
  69000117605: 69000638756, // flexi.documents@bankopen.co → Flexi Operations
  69000117869: 69000638831, // abc.documents@bankopen.co → ABC Operations
  69000120860: 69000640497, // letstalk@open.accountant → Open Accountant
  69000120975: 69000640527, // zwitch-integrations@bankopen.co → Zwitch Integrations
  69000121231: 69000642377, // product_support.bizexpress@bankopen.co → Product Support MBDB ( Banking )
  69000121540: 69000641095, // customer.success@bankopen.co → Customer Success
  69000121786: 69000383372, // open-saas@bankopen.co → Product Experience & Growth
  69000122491: 69000641958, // support@zwitch.io → Zwitch Product Support
  69000122528: 69000641958, // zwitch-support@bankopen.co → Zwitch Product Support
  69000123217: 69000642374, // letstalk@mybusinessapp.co → PEG HDFC
  69000123218: 69000634138, // mat@bankopen.co → MAT_OPS
  69000123407: 69000642406, // pg.mbdb@bankopen.co → PG MBDB_HDFC
  69000123408: 69000642407, // kyc.mbdb@bankopen.co → KYC MBDB_HDFC
  69000123409: 69000642408, // lea.mbdb@bankopen.co → LEA MBDB_HDFC
  69000123410: 69000642409, // chargeback.mbdb@bankopen.co → CB MBDB_HDFC
  69000124047: 69000642927, // optotax-support@bankopen.co → Optotax Product Support
  69000125267: 69000643580, // pg.operations@bankopen.co → PG_OPS_MID
  69000125269: 69000643581, // hdfc.pg.reports@bankopen.co → HDFC_PG_Reports
  69000126151: 69000643952, // noc-axisneo@bankopen.co → Axis Neo - NOC
  69000126334: 69000644146, // lsp.grievances@bankopen.co → Open Capital Grievance
  69000127220: 69000644742, // letstalk@getcaramel.ai → PEG Caramel
  69000127938: 69000383372, // escalations@bankopen.co → Product Experience & Growth
  69000127939: 69000383372, // grievances@bankopen.co → Product Experience & Growth
  69000132422: 69000647123, // support@optotax.com → Optotax PEG
};

/** support_email (lowercase) → default group_id */
export const EMAIL_TO_GROUP: Record<string, number> = {
  'abc.documents@bankopen.co': 69000638831, // → ABC Operations
  'anish.achuthan@open.money': 69000383372, // → Product Experience & Growth
  'axisbank_support@bankopen.co': 69000637254, // → Product Support - Banking Stack
  'chargeback.mbdb@bankopen.co': 69000642409, // → CB MBDB_HDFC
  'creditops_blpl@bankopen.co': 69000635197, // → Lending Team
  'customer.success@bankopen.co': 69000641095, // → Customer Success
  'disputes@bankopen.co': 69000438796, // → FR&CB_no_reply
  'escalations@bankopen.co': 69000383372, // → Product Experience & Growth
  'flexi.documents@bankopen.co': 69000638756, // → Flexi Operations
  'grievances@bankopen.co': 69000383372, // → Product Experience & Growth
  'hdfc.pg.reports@bankopen.co': 69000643581, // → HDFC_PG_Reports
  'kyc.mbdb@bankopen.co': 69000642407, // → KYC MBDB_HDFC
  'kyc@bankopen.co': 69000383382, // → KYC Team
  'kycteam@openbook.co': 69000625786, // → KYCteam_OpenBook
  'lea.mbdb@bankopen.co': 69000642408, // → LEA MBDB_HDFC
  'lending_support@bankopen.co': 69000634184, // → Lending Team Tech Support
  'letstalk@bankopen.co': 69000383372, // → Product Experience & Growth
  'letstalk@getcaramel.ai': 69000644742, // → PEG Caramel
  'letstalk@mybusinessapp.co': 69000642374, // → PEG HDFC
  'letstalk@open.accountant': 69000640497, // → Open Accountant
  'letstalk@open.money': 69000383372, // → Product Experience & Growth
  'letstalk@openbook.co': 69000622134, // → OpenBook
  'letstalk@openmoney.co': 69000383372, // → Product Experience & Growth
  'letstalk@zwitch.io': 69000643476, // → Zwitch Customer Support
  'lk.documents@bankopen.co': 69000638755, // → LendingKart Operations
  'lsp.grievances@bankopen.co': 69000644146, // → Open Capital Grievance
  'mat@bankopen.co': 69000634138, // → MAT_OPS
  'noc-axisneo@bankopen.co': 69000643952, // → Axis Neo - NOC
  'nodal.officer@bankopen.co': 69000438795, // → Nod_no_reply
  'open-saas@bankopen.co': 69000383372, // → Product Experience & Growth
  'open.cards@bankopen.co': 69000633818, // → CARDS_OPS
  'optotax-support@bankopen.co': 69000642927, // → Optotax Product Support
  'pg-support@bankopen.co': 69000428835, // → Integration Support
  'pg.mbdb@bankopen.co': 69000642406, // → PG MBDB_HDFC
  'pg.operations@bankopen.co': 69000643580, // → PG_OPS_MID
  'product_support.bizexpress@bankopen.co': 69000642377, // → Product Support MBDB ( Banking )
  'product_support@bankopen.co': 69000428825, // → Product Support
  'risk_team@bankopen.co': 69000383381, // → Riskteam_OpenMoney
  'riskteam@openbook.co': 69000625784, // → Riskteam_OpenBook
  'settlements.refunds@bankopen.co': 69000447196, // → Settlement Team
  'support@bankonnect.co': 69000383372, // → Product Experience & Growth
  'support@optotax.com': 69000647123, // → Optotax PEG
  'support@zwitch.io': 69000641958, // → Zwitch Product Support
  'zwitch-integrations@bankopen.co': 69000640527, // → Zwitch Integrations
  'zwitch-support@bankopen.co': 69000641958, // → Zwitch Product Support
};

/** L1 customer support default — most generic queries land here */
export const PEG_DEFAULT_GROUP_ID = 69000383372;

/** L2 technical support default — for API/integration/backend issues */
export const PRODUCT_SUPPORT_GROUP_ID = 69000428825;

/** Escalation target — VIP, RBI complaints, legal threats, etc. */
export const PEG_ESCALATIONS_GROUP_ID = 69000633303;

export const GROUP_NAME_BY_ID = new Map<number, string>(
  FRESHDESK_GROUPS.map(g => [g.id, g.name])
);
