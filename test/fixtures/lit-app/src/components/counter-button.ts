import { html, LitElement, type TemplateResult } from "lit";
import { formatCount } from "../utils/format";

export class CounterButton extends LitElement {
	static properties = {
		step: { type: Number },
		count: { state: true },
	};

	declare step: number;
	declare count: number;

	constructor() {
		super();
		this.step = 1;
		this.count = 0;
	}

	private increment(): void {
		this.count += this.step;
		this.dispatchEvent(
			new CustomEvent<number>("count-changed", {
				detail: this.count,
				bubbles: true,
				composed: true,
			}),
		);
	}

	render(): TemplateResult {
		return html`
			<button type="button" @click=${this.increment}>
				${formatCount(this.count)}
			</button>
		`;
	}
}

customElements.define("counter-button", CounterButton);

declare global {
	interface HTMLElementTagNameMap {
		"counter-button": CounterButton;
	}
}
