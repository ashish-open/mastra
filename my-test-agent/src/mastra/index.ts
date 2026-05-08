
import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { deployMeetingBotWorkflow, processMeetingWorkflow } from './workflows/meeting-workflow';
import { supportTriageWorkflow } from './workflows/support-triage-workflow';
import { weatherAgent } from './agents/weather-agent';
import { zeusAgent } from './agents/zeus-agent';
import { knowledgeAgent } from './agents/knowledge-agent';
import { meetingAgent } from './agents/meeting-agent';
import { supportTriageAgent } from './agents/support-triage-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { recallWebhookRoute } from './routes/recall-webhook';
import { freshdeskWebhookRoute } from './routes/freshdesk-webhook';

export const mastra = new Mastra({
  workflows: { weatherWorkflow, deployMeetingBotWorkflow, processMeetingWorkflow, supportTriageWorkflow },
  agents: { weatherAgent, zeusAgent, knowledgeAgent, meetingAgent, supportTriageAgent },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  server: {
    apiRoutes: [recallWebhookRoute, freshdeskWebhookRoute],
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
