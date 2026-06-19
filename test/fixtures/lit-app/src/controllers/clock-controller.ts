import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * A ReactiveController — Lit's composition primitive (the rough analog of a
 * React hook). Drives periodic re-renders of its host element.
 */
export class ClockController implements ReactiveController {
	value = new Date();

	private readonly host: ReactiveControllerHost;
	private readonly intervalMs: number;
	private timerId: ReturnType<typeof setInterval> | null = null;

	constructor(host: ReactiveControllerHost, intervalMs = 1000) {
		this.host = host;
		this.intervalMs = intervalMs;
		host.addController(this);
	}

	hostConnected(): void {
		this.timerId = setInterval(() => {
			this.value = new Date();
			this.host.requestUpdate();
		}, this.intervalMs);
	}

	hostDisconnected(): void {
		if (this.timerId !== null) {
			clearInterval(this.timerId);
			this.timerId = null;
		}
	}
}
