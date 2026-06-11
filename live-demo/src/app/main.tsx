import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LiveEvent, LiveSnapshot } from '../shared/types.js';
import './styles.css';

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

type ChartPoint = {
  time: string;
  price: number | null;
  pool: number;
  hedge: number;
  net: number;
  pending: number;
  collateral: number;
};

function App() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    fetchState().catch((cause) => setError(String(cause)));
    const source = new EventSource('/api/demo/events');
    source.addEventListener('snapshot', (message) => {
      const next = JSON.parse((message as MessageEvent).data) as LiveSnapshot;
      setSnapshot(next);
      setHistory((current) => [...current.slice(-120), toPoint(next)]);
    });
    source.addEventListener('event', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as LiveEvent;
      setEvents((current) => [event, ...current].slice(0, 80));
    });
    source.onerror = () => setError('Live event stream disconnected. Is the local API running?');
    return () => source.close();
  }, []);

  async function fetchState() {
    const result = await fetch('/api/demo/state');
    const json = (await result.json()) as ApiResponse<LiveSnapshot>;
    if (!json.ok || !json.data) throw new Error(json.error || 'State request failed.');
    const next = json.data;
    setSnapshot(next);
    setHistory((current) => [...current.slice(-120), toPoint(next)]);
  }

  async function action(label: string, path: string) {
    setBusy(label);
    setError(null);
    try {
      const result = await fetch(path, { method: 'POST', headers: armed ? { 'x-demo-arm': 'armed' } : {} });
      const json = (await result.json()) as ApiResponse<LiveSnapshot>;
      if (!json.ok) throw new Error(json.error || `${label} failed.`);
      if (json.data) {
        const next = json.data;
        setSnapshot(next);
        setHistory((current) => [...current.slice(-120), toPoint(next)]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const totals = useMemo(() => {
    const traders = snapshot?.traders ?? [];
    return {
      submitted: traders.reduce((sum, trader) => sum + trader.swapsSubmitted, 0),
      confirmed: traders.reduce((sum, trader) => sum + trader.swapsConfirmed, 0),
      failed: traders.reduce((sum, trader) => sum + trader.swapsFailed, 0),
    };
  }, [snapshot]);

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Production hook live arena</p>
          <h1>Delta-neutral pressure test</h1>
        </div>
        <div className={`status ${snapshot?.status === 'Defensive' ? 'danger' : ''}`}>{snapshot?.status ?? 'Loading'}</div>
      </header>

      {error ? <div className="banner">{error}</div> : null}

      <section className="controlStrip">
        <label className="armSwitch">
          <input type="checkbox" checked={armed} onChange={(event) => setArmed(event.currentTarget.checked)} />
          Arm live transaction controls
        </label>
        <button disabled={Boolean(busy)} onClick={() => action('Prepare wallets', '/api/demo/prepare')}>Prepare wallets</button>
        <button disabled={Boolean(busy) || !armed} onClick={() => action('Fund traders', '/api/demo/fund')}>Fund traders</button>
        <button disabled={Boolean(busy) || !armed} onClick={() => action('Start trading', '/api/demo/start-trading')}>Start trading</button>
        <button disabled={Boolean(busy)} onClick={() => action('Pause trading', '/api/demo/stop-trading')}>Pause trading</button>
        <button disabled={Boolean(busy) || !armed} onClick={() => action('Start keeper', '/api/demo/start-keeper')}>Start keeper</button>
        <button disabled={Boolean(busy)} onClick={() => action('Stop keeper', '/api/demo/stop-keeper')}>Stop keeper</button>
        <button disabled={Boolean(busy) || !armed} onClick={() => action('Defensive mode', '/api/demo/scenario/defensive')}>Trigger defensive</button>
        <button disabled={Boolean(busy) || !armed} onClick={() => action('Recover', '/api/demo/scenario/recover')}>Recover</button>
        <button className="stop" disabled={Boolean(busy)} onClick={() => action('Stop all', '/api/demo/stop-all')}>Stop all</button>
      </section>

      {busy ? <p className="busy">{busy} is running...</p> : null}

      <section className="metrics">
        <Metric label="Pool price" value={snapshot?.poolPriceUsd ? `$${snapshot.poolPriceUsd.toFixed(2)}` : `$${snapshot?.lastMarkPriceUsd ?? '0'}`} detail={snapshot?.tick ? `tick ${snapshot.tick}` : 'adapter mark fallback'} />
        <Metric label="Net delta" value={snapshot?.netBaseDelta ?? '0'} detail={`${snapshot?.poolBaseExposure ?? '0'} pool + ${snapshot?.hedgePositionBase ?? '0'} hedge`} />
        <Metric label="Pending hedge" value={snapshot?.pendingOrderBase ?? '0'} detail={snapshot?.pendingOrderId?.slice(0, 10) ?? 'no order'} />
        <Metric label="Collateral" value={`$${snapshot?.collateralUsd ?? '0'}`} detail={`PnL ${snapshot?.realizedPnlUsd ?? '0'} / ${snapshot?.unrealizedPnlUsd ?? '0'}`} />
        <Metric label="Trader txs" value={`${totals.confirmed}/${totals.submitted}`} detail={`${totals.failed} failed`} />
      </section>

      <section className="grid">
        <Panel title="Price Movement">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={history}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" minTickGap={28} />
              <YAxis domain={['auto', 'auto']} />
              <Tooltip />
              <Line type="monotone" dataKey="price" stroke="#0077b6" dot={false} strokeWidth={2} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Delta Compensation">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={history}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" minTickGap={28} />
              <YAxis />
              <Tooltip />
              <Area type="monotone" dataKey="pool" stackId="delta" stroke="#8a5cf6" fill="#c4b5fd" />
              <Area type="monotone" dataKey="hedge" stackId="delta" stroke="#008f5a" fill="#9be7c2" />
              <Line type="monotone" dataKey="net" stroke="#d00000" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="pending" stroke="#f48c06" dot={false} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>
      </section>

      <section className="grid lower">
        <Panel title="Trader Fleet">
          <div className="traderGrid">
            {(snapshot?.traders ?? []).map((trader) => (
              <div className="trader" key={trader.address}>
                <div className="traderTop">
                  <strong>#{trader.id}</strong>
                  <span className={trader.ready ? 'pill ok' : 'pill'}>{trader.ready ? 'ready' : 'setup'}</span>
                </div>
                <code>{trader.address.slice(0, 8)}...{trader.address.slice(-6)}</code>
                <p>{Number(trader.nativeBalanceEth).toFixed(4)} ETH</p>
                <p>{trader.swapsConfirmed}/{trader.swapsSubmitted} swaps</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Live Event Tape">
          <div className="eventTape">
            {events.map((event) => (
              <div className={`event ${event.kind}`} key={event.id}>
                <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                <p>{event.message}</p>
                {event.txHash ? <code>{event.txHash.slice(0, 10)}...{event.txHash.slice(-6)}</code> : null}
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <footer>
        <code>{snapshot?.config.hook ?? ''}</code>
        <span>{snapshot?.config.network ?? ''}</span>
        <span>traders {snapshot?.config.traderCount ?? 0}</span>
        <span>{snapshot?.runningTrading ? 'trading on' : 'trading paused'}</span>
        <span>{snapshot?.runningKeeper ? 'keeper on' : 'keeper paused'}</span>
      </footer>
    </main>
  );
}

function Metric(props: { label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <p>{props.label}</p>
      <strong>{props.value}</strong>
      <span>{props.detail}</span>
    </div>
  );
}

function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

function toPoint(snapshot: LiveSnapshot): ChartPoint {
  return {
    time: new Date(snapshot.timestamp).toLocaleTimeString(),
    price: snapshot.poolPriceUsd,
    pool: Number(snapshot.poolBaseExposure),
    hedge: Number(snapshot.hedgePositionBase),
    net: Number(snapshot.netBaseDelta),
    pending: Number(snapshot.pendingOrderBase),
    collateral: Number(snapshot.collateralUsd),
  };
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
