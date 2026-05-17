
import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { deployMeetingBotWorkflow, processMeetingWorkflow } from './workflows/meeting-workflow';
import { supportTriageWorkflow } from './workflows/support-triage-workflow';
import { reconcileWorkflow } from './reconciliation/workflow';
// Ensure reco adapters + configs are registered at app startup
import { ensureConfigsRegistered, RECO_CONFIGS_LOADED } from './reconciliation/configs';
void RECO_CONFIGS_LOADED;
ensureConfigsRegistered();
import { zeusAgent } from './agents/zeus-agent';
import { knowledgeAgent } from './agents/knowledge-agent';
import { meetingAgent } from './agents/meeting-agent';
import { supportTriageAgent } from './agents/support-triage-agent';
import { fuzzyMatchAgent, dispositionAgent } from './reconciliation/agents';
import {
  candidateValidityScorer,
  dispositionAccuracyScorer,
  reasoningQualityScorer,
} from './reconciliation/evals/scorers';
import { recallWebhookRoute } from './routes/recall-webhook';
import { freshdeskWebhookRoute } from './routes/freshdesk-webhook';
import { recoUploadRoute } from './routes/reco-upload';
import {
  integrationInfoRoute,
  integrationRecoRunsRoute,
  integrationRecoDecisionsRoute,
} from './routes/integration';

export const mastra = new Mastra({
  workflows: {
    deployMeetingBotWorkflow,
    processMeetingWorkflow,
    supportTriageWorkflow,
    reconcileWorkflow,
  },
  agents: {
    zeusAgent,
    knowledgeAgent,
    meetingAgent,
    supportTriageAgent,
    fuzzyMatchAgent,
    dispositionAgent,
  },
  scorers: {
    candidateValidityScorer,
    dispositionAccuracyScorer,
    reasoningQualityScorer,
  },
  server: {
    apiRoutes: [
      recallWebhookRoute,
      freshdeskWebhookRoute,
      recoUploadRoute,
      // Integration surface — external apps (OpenArc, etc.) call these
      integrationInfoRoute,
      integrationRecoRunsRoute,
      integrationRecoDecisionsRoute,
    ],
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: 'file:./mastra.db',
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
