import React, { useCallback, useContext, useEffect, useState } from "react";
import { Button, Select, Space, Table } from "antd";
import {
	ControlContext, PageHeader, PageLayout, notifyErrorHandler, useAccount, type WebPluginContext,
} from "@clusterio/web_ui";
import { MoveRequest, StatusRequest, type Status } from "../contracts.js";

type Tile = Status["tiles"][number];
type Move = Status["moves"][number];

/**
 * §11's minimal page: each instance's host, UPS, CPU ms per tick, players and copy age, a Move control, and the moves.
 * ponytail: Refresh reloads, with no live subscription; phase 2 replaces it with §4.4's page.
 */
function BalancerPage() {
	const control = useContext(ControlContext);
	const account = useAccount();
	const [status, setStatus] = useState<Status>();
	const [targets, setTargets] = useState<Record<number, number | undefined>>({});
	const canMove = account.hasPermission("balancer.move") === true;

	const load = useCallback(() => {
		control.send(new StatusRequest()).then(setStatus).catch(notifyErrorHandler("Loading the balancer failed"));
	}, [control]);
	useEffect(load, [load]);

	function move(t: Tile) {
		control.send(new MoveRequest(t.id, targets[t.id])).then(load).catch(notifyErrorHandler("The move was refused"));
	}

	const now = Date.now();
	const hosts = (status?.hosts ?? []).filter(h => h.connected);
	const age = (t: Tile) => (
		t.copyMtimeMs === null ? "none" : `${Math.round((now - t.copyMtimeMs) / 60_000)} min old`
	);
	// A finished back-move is the source taking the tile back; one still going, or failed, shows as usual (C13/C30).
	const error = (m: Move) => (m.back && m.step === "done" ? `returned: ${m.error ?? ""}` : m.error ?? "");
	return <PageLayout nav={[{ name: "Balancer" }]}>
		<PageHeader title="Balancer" extra={<Button onClick={load}>Refresh</Button>} />
		<Table<Tile>
			size="small"
			pagination={false}
			dataSource={status?.tiles ?? []}
			rowKey="id"
			columns={[
				{ title: "Instance", key: "name", render: (_, t) => t.name },
				{ title: "Host", key: "host", render: (_, t) => t.host ?? "-" },
				{ title: "Status", key: "status", render: (_, t) => t.status },
				{ title: "UPS", key: "ups", render: (_, t) => t.ups?.toFixed(1) ?? "-" },
				{ title: "ms/tick", key: "ms", render: (_, t) => t.ms?.toFixed(2) ?? "-" },
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
							options={hosts.filter(h => h.id !== t.host).map(h => ({ value: h.id, label: h.name }))}
						/>
						<Button size="small" disabled={!canMove || t.players > 0} onClick={() => move(t)}>Move</Button>
					</Space>,
				},
			]}
		/>
		<h3 style={{ marginTop: 16 }}>Moves</h3>
		<Table<Move>
			size="small"
			pagination={false}
			dataSource={[...(status?.moves ?? [])].reverse()}
			rowKey="id"
			columns={[
				{ title: "Move", key: "id", render: (_, m) => m.id },
				{ title: "Instance", key: "instance", render: (_, m) => m.instanceId },
				{ title: "From", key: "from", render: (_, m) => m.from ?? "-" },
				{ title: "To", key: "to", render: (_, m) => m.to ?? "-" },
				{ title: "Reason", key: "reason", render: (_, m) => m.reason },
				{ title: "Step", key: "step", render: (_, m) => m.step },
				{ title: "Error", key: "error", render: (_, m) => error(m) },
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
