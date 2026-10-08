// The in-process API for other controller plugins (spec §4.5), imported from "balancer/api" like universal_edges/edges.

export interface BalancerApi {
	/** A move of this instance is queued or in progress: gridworld neither starts, stops nor assigns it (§8). */
	moving(instanceId: number): boolean;
	/** The host is draining (§5.4): gridworld's round-robin skips it (§8). */
	draining(hostId: number): boolean;
	/** Runs after each move ends, done or failed; returns the unsubscribe. */
	onMoveFinished(listener: (instanceId: number) => void): () => void;
}

let current: BalancerApi | undefined;

/**
 * The balancer's API. Clusterio keeps no plugin registry, so this is a module singleton the balancer's controller
 * plugin sets as it loads: call it from a hook or a pass, never at import time. Throws while it isn't set.
 */
export function balancerApi(): BalancerApi {
	if (!current) {
		throw new Error("balancer: the API is not ready; is the balancer plugin loaded?");
	}
	return current;
}

export function setBalancerApi(api: BalancerApi | undefined): void {
	current = api;
}
