import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { formatCount } from "../utils/format";

@customElement("counter-button")
export class CounterButton extends LitElement {
	@property({ type: Number })
	accessor step = 1;

	@state()
	private accessor count = 0;

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

declare global {
	interface HTMLElementTagNameMap {
		"counter-button": CounterButton;
	}
}
