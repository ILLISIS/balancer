/**
 * The fence (spec §7, B10): a host cut off from the controller for `minutes()` stops its own tiles, so a failover
 * (after a longer grace) never meets a live copy. A drop arms it, a connect or resume disarms it, and a second drop
 * keeps the first one's clock. Spike 32: a stale copy still running when its host returns makes that host exit.
 */
export type FenceEvent = "connect" | "drop" | "resume" | "close";

/**
 * A graceful controller stop closes the link without a drop; unless this host is the one quitting (a timer would hold
 * its process open), that is a drop.
 */
export function fenceEvent(event: FenceEvent, shuttingDown: boolean): FenceEvent {
	return event === "close" && !shuttingDown ? "drop" : event;
}

export class Fence {
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private minutes: () => number, private fire: () => void) { }

	event(event: FenceEvent): void {
		if (event === "drop" && this.timer === undefined) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.fire();
			}, this.minutes() * 60_000);
		} else if (event === "connect" || event === "resume") {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	get armed(): boolean {
		return this.timer !== undefined;
	}
}
