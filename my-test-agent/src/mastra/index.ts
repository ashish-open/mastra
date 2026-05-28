
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mastra } from '@mastra/core/mastra';

// Anchor file-based stores to the project root so different entry points
// (`mastra dev` which runs from .mastra/output, eval scripts which run from
// the project root) all hit the same files. Without this, Studio and the
// eval runner end up reading two different mastra.db files.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_FILE = process.env.MASTRA_DB_PATH ?? path.join(PROJECT_ROOT, 'mastra.db');
import { MastraCompositeStore } from '@mastra/core/storage';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { deployMeetingBotWorkflow, processMeetingWorkflow } from './workflows/meeting-workflow';
import { supportTriageWorkflow } from './workflows/support-triage-workflow';
import { reconcileWorkflow, settlementReconWorkflow } from './reconciliation/workflow';
// Ensure reco adapters + configs are registered at app startup
import { ensureConfigsRegistered, RECO_CONFIGS_LOADED } from './reconciliation/configs';
void RECO_CONFIGS_LOADED;
ensureConfigsRegistered();

// Ensure meetings DB schema is present on every startup (idempotent)
void migrateMeetingsDb().catch(err => {
  console.warn('[meetings-db] Migration failed (non-fatal):', err instanceof Error ? err.message : err);
});
import { zeusAgent } from './agents/zeus-agent';
import { knowledgeAgent } from './agents/knowledge-agent';
import { meetingAgent } from './agents/meeting-agent';
import { supportTriageAgent } from './agents/support-triage-agent';
import { supportAnalyzerAgent } from './agents/support-analyzer-agent';
import { supportDrafterAgent } from './agents/support-drafter-agent';
import { fuzzyMatchAgent, dispositionAgent } from './reconciliation/agents';
import {
  candidateValidityScorer,
  dispositionAccuracyScorer,
  reasoningQualityScorer,
} from './reconciliation/evals/scorers';
import { seedRecoDatasets } from './reconciliation/evals/seed-datasets';
import { supportClassifierAgent } from './support-triage-evals/classifier-agent';
import { categoryAccuracyScorer } from './support-triage-evals/scorers';
import { seedSupportTriageDataset } from './support-triage-evals/seed-datasets';
import { retrievalRecallScorer } from './knowledge-evals/scorers';
import { seedKnowledgeDataset } from './knowledge-evals/seed-datasets';
import { meetingActionItemExtractorAgent } from './meeting-evals/extractor-agent';
import { actionItemRecallScorer } from './meeting-evals/scorers';
import { seedMeetingDataset } from './meeting-evals/seed-datasets';
import { zeusDecisionAgent } from './zeus-evals/decision-agent';
import { refusalAccuracyScorer } from './zeus-evals/scorers';
import { seedZeusDataset } from './zeus-evals/seed-datasets';
import { migrateMeetingsDb } from './meetings/db';
import { recallWebhookRoute } from './routes/recall-webhook';
import { recallRecoverRoute, recallReprocessRoute } from './routes/recall-recover';
import { recallAskRoute } from './routes/recall-ask';
import { freshdeskWebhookRoute } from './routes/freshdesk-webhook';
import { recoUploadRoute, recoStagedListRoute, recoStagedDeleteRoute, recoFetchRoute } from './routes/reco-upload';
import { recoMcpRazorpayTestRoute, recoMcpRazorpaySeedRoute } from './routes/mcp-test';
import {
  integrationInfoRoute,
  integrationRecoRunsRoute,
  integrationRecoDecisionsRoute,
  integrationMeetingsListRoute,
  integrationMeetingDetailRoute,
} from './routes/integration';
import {
  integrationRecoReportPackManifestRoute,
  integrationRecoReportPackFileRoute,
} from './routes/reco-report-pack';

export const mastra = new Mastra({
  workflows: {
    deployMeetingBotWorkflow,
    processMeetingWorkflow,
    supportTriageWorkflow,
    reconcileWorkflow,
    settlementReconWorkflow,
  },
  agents: {
    zeusAgent,
    knowledgeAgent,
    meetingAgent,
    supportTriageAgent,
    supportAnalyzerAgent,
    supportDrafterAgent,
    supportClassifierAgent,
    meetingActionItemExtractorAgent,
    zeusDecisionAgent,
    fuzzyMatchAgent,
    dispositionAgent,
  },
  scorers: {
    candidateValidityScorer,
    dispositionAccuracyScorer,
    reasoningQualityScorer,
    categoryAccuracyScorer,
    retrievalRecallScorer,
    actionItemRecallScorer,
    refusalAccuracyScorer,
  },
  server: {
    apiRoutes: [
      recallWebhookRoute,
      recallRecoverRoute,
      recallReprocessRoute,
      recallAskRoute,
      freshdeskWebhookRoute,
      recoUploadRoute,
      recoStagedListRoute,
      recoStagedDeleteRoute,
      recoFetchRoute,
      recoMcpRazorpayTestRoute,
      recoMcpRazorpaySeedRoute,
      // Integration surface — external apps (OpenArc, etc.) call these
      integrationInfoRoute,
      integrationRecoRunsRoute,
      integrationRecoDecisionsRoute,
      integrationRecoReportPackManifestRoute,
      integrationRecoReportPackFileRoute,
      integrationMeetingsListRoute,
      integrationMeetingDetailRoute,
    ],
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: `file:${DB_FILE}`,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
          new CloudExporter(), // Sends traces to Mastra Cloud (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});

// Seed reco eval datasets into Studio (idempotent — skips if already present).
// Fire-and-forget on boot. We don't await the Mastra constructor's
// readiness explicitly because `mastra.datasets` proxies through the storage
// domain which is ready by the time the Mastra ctor returns above. Errors are
// logged, never thrown — a seed failure must not crash the dev server.
void seedRecoDatasets(mastra)
  .then(report => {
    const { fuzzy, disposition } = report;
    const fuzzyTag = fuzzy.created ? `seeded ${fuzzy.itemCount} items` : 'already present';
    const dispTag = disposition.created ? `seeded ${disposition.itemCount} items` : 'already present';
    console.log(`[reco] Datasets — fuzzy: ${fuzzyTag} (${fuzzy.datasetId}); disposition: ${dispTag} (${disposition.datasetId})`);
  })
  .catch(err => {
    console.warn('[reco] seedRecoDatasets failed (non-fatal):', err instanceof Error ? err.message : err);
  });

void seedSupportTriageDataset(mastra)
  .then(report => {
    const tag = report.created ? `seeded ${report.itemCount} items` : 'already present';
    console.log(`[triage] Dataset — classification: ${tag} (${report.datasetId})`);
  })
  .catch(err => {
    console.warn('[triage] seedSupportTriageDataset failed (non-fatal):', err instanceof Error ? err.message : err);
  });

void seedKnowledgeDataset(mastra)
  .then(report => {
    const tag = report.created ? `seeded ${report.itemCount} items` : 'already present';
    console.log(`[knowledge] Dataset — retrieval: ${tag} (${report.datasetId})`);
  })
  .catch(err => {
    console.warn('[knowledge] seedKnowledgeDataset failed (non-fatal):', err instanceof Error ? err.message : err);
  });

void seedMeetingDataset(mastra)
  .then(report => {
    const tag = report.created ? `seeded ${report.itemCount} items` : 'already present';
    console.log(`[meeting] Dataset — action-items: ${tag} (${report.datasetId})`);
  })
  .catch(err => {
    console.warn('[meeting] seedMeetingDataset failed (non-fatal):', err instanceof Error ? err.message : err);
  });

void seedZeusDataset(mastra)
  .then(report => {
    const tag = report.created ? `seeded ${report.itemCount} items` : 'already present';
    console.log(`[zeus] Dataset — refusal: ${tag} (${report.datasetId})`);
  })
  .catch(err => {
    console.warn('[zeus] seedZeusDataset failed (non-fatal):', err instanceof Error ? err.message : err);
  });
