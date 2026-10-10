import React, { useCallback, useContext, useEffect, useState } from "react";
import { Button, Select, Space, Switch, Table, type TableColumnsType } from "antd";
import {
	ControlContext, PageHeader, PageLayout, notifyErrorHandler, useAccount, type WebPluginContext,
} from "@clusterio/web_ui";
import { BenchmarkRequest, DrainRequest, MoveRequest, StatusRequest, type Status } from "../contracts.js";

type Host = Status["hosts"][number];
type Tile = Status["tiles"][number];
type Move = Status["moves"][number];

/** The page reloads the status this often (R17). */
const REFRESH_MS = 10_000;
const fixed = (n: number | null, digits: number) => (n === null ? "-" : n.toFixed(digits));
const ended = (m: Move) => m.step === "done" || m.step === "failed";
const gb = (bytes: number) => `${(Math.max(0, bytes) / 2 ** 30).toFixed(1)} GB`;

/** Memory amendment §3.2: the memory in use against the host's limit, and its room for a new tile. */
function memory(h: Host): string {
	return h.usedPct === null
		? `no reading; limit ${h.limitPct}%`
		: `${h.usedPct.toFixed(0)}% of ${h.limitPct}%; room ${gb(h.room)}`;
}

/** A move's outcome: its step, with its error; a finished way back shows why it came back (C13, C30). */
function result(m: Move): string {
	if (m.back && m.step === "done") {
		return `returned: ${m.error ?? ""}`;
	}
	return m.error === null ? m.step : `${m.step}: ${m.error}`;
}

/** The after-check (§5.6): its verdict, T's UPS and ms per tick on the target, and its neighbours' lowest UPS. */
function check(m: Move): string {
	const c = m.check;
	if (c === null) {
		return "-";
	}
	let verdict = "skipped";
	if (c.ok !== null) {
		verdict = c.ok ? "passed" : "failed";
	}
	return `${verdict}: ${fixed(c.ups, 1)} UPS, ${fixed(c.ms, 2)} ms; others ≥ ${fixed(c.othersMinUps, 1)} UPS`;
}

/**
 * §4.4: the hosts (connected or gone, speed, slots, busy tiles, memory, the drain toggle, "benchmark now"), the
 * tiles (host, UPS, CPU ms per tick, memory need, players, the save copy's age, and a Move control), and the moves:
 * in progress and the ledger.
 */
function BalancerPage() {
	const control = useContext(ControlContext);
	const account = useAccount();
	const [status, setStatus] = useState<Status>();
	const [targets, setTargets] = useState<Record<number, number | undefined>>({});
	const canAct = account.hasPermission("balancer.move") === true;

	const load = useCallback(() => {
		control.send(new StatusRequest()).then(setStatus).catch(notifyErrorHandler("Loading the balancer failed"));
	}, [control]);
	useEffect(() => {
		load();
		const timer = setInterval(load, REFRESH_MS);
		return () => clearInterval(timer);
	}, [load]);

	function move(t: Tile) {
		control.send(new MoveRequest(t.id, targets[t.id])).then(load).catch(notifyErrorHandler("The move was refused"));
	}
	function drain(h: Host, on: boolean) {
		control.send(new DrainRequest(h.id, on)).then(load).catch(notifyErrorHandler("The drain toggle failed"));
	}
	function benchmark(h: Host) {
		control.send(new BenchmarkRequest(h.id)).then(load).catch(notifyErrorHandler("The benchmark was refused"));
	}

	const now = Date.now();
	const hosts = status?.hosts ?? [];
	const tiles = status?.tiles ?? [];
	const moves = status?.moves ?? [];
	const hostName = (id: number | null) => (id === null ? "-" : hosts.find(h => h.id === id)?.name ?? String(id));
	const tileName = (id: number) => tiles.find(t => t.id === id)?.name ?? String(id);
	const tileCount = (h: Host) => tiles.filter(t => t.host === h.id).length;
	const age = (t: Tile) => (
		t.copyMtimeMs === null ? "none" : `${Math.round((now - t.copyMtimeMs) / 60_000)} min old`
	);
	const route: TableColumnsType<Move> = [
		{ title: "Instance", key: "instance", render: (_, m) => tileName(m.instanceId) },
		{ title: "From", key: "from", render: (_, m) => hostName(m.from) },
		{ title: "To", key: "to", render: (_, m) => hostName(m.to) },
		{ title: "Reason", key: "reason", render: (_, m) => m.reason },
	];
	return <PageLayout nav={[{ name: "Balancer" }]}>
		<PageHeader title="Balancer" extra={<Button onClick={load}>Refresh</Button>} />
		<h3>Hosts</h3>
		<Table<Host>
			size="small"
			pagination={false}
			dataSource={hosts}
			rowKey="id"
			columns={[
				{ title: "Host", key: "name", render: (_, h) => h.name },
				{ title: "State", key: "state", render: (_, h) => (h.connected ? "connected" : "gone") },
				{
					title: "Speed (ms/tick)",
					key: "speed",
					render: (_, h) => (h.speed === null ? "unbenchmarked" : h.speed.toFixed(2)),
				},
				{
					title: "Slots",
					key: "slots",
					render: (_, h) => (h.slots === null ? "-" : `${h.slots}${h.learned ? " (learned)" : ""}`),
				},
				{ title: "Busy tiles", key: "busy", render: (_, h) => h.busy },
				{ title: "Tiles", key: "tiles", render: (_, h) => tileCount(h) },
				{ title: "Memory", key: "memory", render: (_, h) => memory(h) },
				{
					title: "Drain",
					key: "drain",
					render: (_, h) => <Space>
						<Switch size="small" checked={h.draining} disabled={!canAct} onChange={on => drain(h, on)} />
						{h.draining && tileCount(h) === 0 ? "drained" : null}
					</Space>,
				},
				{
					title: "Benchmark",
					key: "benchmark",
					render: (_, h) => <Button
						size="small"
						loading={h.benchmarking}
						disabled={!canAct || !h.connected}
						onClick={() => benchmark(h)}
					>Benchmark now</Button>,
				},
			]}
		/>
		<h3 style={{ marginTop: 16 }}>Tiles</h3>
		<Table<Tile>
			size="small"
			pagination={false}
			dataSource={tiles}
			rowKey="id"
			columns={[
				{ title: "Instance", key: "name", render: (_, t) => t.name },
				{ title: "Host", key: "host", render: (_, t) => hostName(t.host) },
				{ title: "Status", key: "status", render: (_, t) => t.status },
				{ title: "UPS", key: "ups", render: (_, t) => fixed(t.ups, 1) },
				{ title: "ms/tick", key: "ms", render: (_, t) => fixed(t.ms, 2) },
				{ title: "Need", key: "need", render: (_, t) => gb(t.need) },
				{ title: "Players", key: "players", render: (_, t) => t.players },
				{ title: "Save copy", key: "copy", render: (_, t) => age(t) },
				{
					title: "Move",
					key: "move",
					render: (_, t) => <Space>
						<Select<number>
							size="small"
							style={{ width: 140 }}
							placeholder="Best host"
							allowClear
							value={targets[t.id]}
							onChange={v => setTargets({ ...targets, [t.id]: v })}
							options={hosts.filter(h => h.connected && h.id !== t.host)
								.map(h => ({ value: h.id, label: h.name }))}
						/>
						<Button size="small" disabled={!canAct || t.players > 0} onClick={() => move(t)}>Move</Button>
					</Space>,
				},
			]}
		/>
		<h3 style={{ marginTop: 16 }}>Moves in progress</h3>
		<Table<Move>
			size="small"
			pagination={false}
			dataSource={moves.filter(m => !ended(m))}
			rowKey="id"
			columns={[...route, { title: "Step", key: "step", render: (_, m) => m.step }]}
		/>
		<h3 style={{ marginTop: 16 }}>Ledger</h3>
		<Table<Move>
			size="small"
			pagination={{ pageSize: 20 }}
			dataSource={moves.filter(ended).reverse()}
			rowKey="id"
			columns={[
				{ title: "Ended", key: "ended", render: (_, m) => new Date(m.endedAt ?? 0).toLocaleString() },
				...route,
				{ title: "Result", key: "result", render: (_, m) => result(m) },
				{
					title: "Pre-flight (predicted)",
					key: "preflight",
					render: (_, m) => (m.preflight === null ? "-"
						: `${fixed(m.preflight.msPerTick, 2)} ms; target ≥ ${fixed(m.preflight.minUps, 1)} UPS`),
				},
				{ title: "After-check (measured)", key: "check", render: (_, m) => check(m) },
			]}
		/>
	</PageLayout>;
}

/** The web entry point (the pin's function form, packages/create/templates/plugin-ts/web/plugin.tsx). */
export default async function loadWebPlugin(context: WebPluginContext) {
	context.control.hooks.pages.attach(context.plugin.name, () => [
		{
			path: "/balancer",
			sidebarName: "Balancer",
			// Client side only: the controller checks each request's own permission.
			permission: "balancer.view",
			content: <BalancerPage />,
		},
	]);
}
