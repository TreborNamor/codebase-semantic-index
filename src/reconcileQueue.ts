/** Coalesces requests without losing changes received during builds or completion microtasks. */
export class ReconcileQueue {
	private pending = false;
	private force = false;
	private running = false;
	private disposed = false;
	private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

	constructor(private readonly reconcile: (force: boolean) => Promise<void>) {}
	get busy(): boolean { return this.running; }

	request(force = false): Promise<void> {
		if (this.disposed) { return Promise.resolve(); }
		this.pending = true;
		this.force ||= force;
		const completed = new Promise<void>((resolve, reject) => { this.waiters.push({ resolve, reject }); });
		if (!this.running) {
			this.running = true;
			void Promise.resolve().then(() => this.drain());
		}
		return completed;
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending && !this.disposed) {
				this.pending = false;
				const force = this.force;
				this.force = false;
				try { await this.reconcile(force); }
				catch (error) { this.pending = true; this.force ||= force; throw error; }
			}
			// Clear running and settle waiters together, with no await/finally gap to strand a request.
			this.running = false;
			const waiters = this.waiters.splice(0);
			for (const waiter of waiters) { waiter.resolve(); }
		} catch (error) {
			this.running = false;
			const waiters = this.waiters.splice(0);
			for (const waiter of waiters) { waiter.reject(error); }
		}
	}

	dispose(): void { this.disposed = true; }
}
