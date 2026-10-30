import { createApp } from './app.ts';
import { logger } from './observability/logger.ts';

const port = Number(process.env.PORT ?? 3000);
const app = createApp({
  erpInvoiceErrorRate: Number(process.env.ERP_ERROR_RATE ?? 0.3),
  erpLatencyMs: Number(process.env.ERP_LATENCY_MS ?? 300),
});

app.dispatcher.start(200);
app.reconciler.start(60_000);

app.server.listen(port, () => {
  logger.info('server.started', { port, docs: 'openapi.yaml', metrics: `http://localhost:${port}/metrics` });
});

const shutdown = async (signal: string) => {
  logger.info('server.stopping', { signal });
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
