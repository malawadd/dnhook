import cors from 'cors';
import express from 'express';
import { loadDeployment, loadLiveConfig } from './config.js';
import { EventBus } from './eventBus.js';
import { LiveDemoOrchestrator } from './orchestrator.js';

const config = loadLiveConfig();
const deployment = loadDeployment(config.deploymentPath);
const events = new EventBus();
const orchestrator = new LiveDemoOrchestrator(config, deployment, events);
const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/demo/events', (request, response) => {
  events.attach(response);
});

app.get('/api/demo/state', async (_request, response) => {
  await route(response, () => orchestrator.snapshot());
});

app.post('/api/demo/prepare', async (_request, response) => {
  await route(response, () => orchestrator.prepareWallets());
});

app.post('/api/demo/fund', async (_request, response) => {
  await armedRoute(_request, response, () => orchestrator.fundWallets());
});

app.post('/api/demo/start-trading', async (request, response) => {
  await armedRoute(request, response, () => orchestrator.startTrading());
});

app.post('/api/demo/stop-trading', async (_request, response) => {
  await route(response, () => orchestrator.stopTrading());
});

app.post('/api/demo/start-keeper', async (request, response) => {
  await armedRoute(request, response, () => orchestrator.startKeeper());
});

app.post('/api/demo/stop-keeper', async (_request, response) => {
  await route(response, () => orchestrator.stopKeeper());
});

app.post('/api/demo/scenario/defensive', async (request, response) => {
  await armedRoute(request, response, () => orchestrator.triggerDefensiveScenario());
});

app.post('/api/demo/scenario/recover', async (request, response) => {
  await armedRoute(request, response, () => orchestrator.recoverScenario());
});

app.post('/api/demo/stop-all', async (_request, response) => {
  await route(response, () => orchestrator.stopAll());
});

app.listen(config.apiPort, () => {
  events.emit('info', `Live demo API listening on http://localhost:${config.apiPort}`);
  orchestrator.startSnapshotLoop();
});

async function route(response: express.Response, action: () => unknown | Promise<unknown>) {
  try {
    response.json({ ok: true, data: await action(), events: events.recentEvents() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    events.emit('error', message);
    response.status(500).json({ ok: false, error: message });
  }
}

async function armedRoute(request: express.Request, response: express.Response, action: () => unknown | Promise<unknown>) {
  if (request.header('x-demo-arm') !== 'armed') {
    response.status(409).json({ ok: false, error: 'Arm the local demo before sending transaction-producing commands.' });
    return;
  }
  await route(response, action);
}
