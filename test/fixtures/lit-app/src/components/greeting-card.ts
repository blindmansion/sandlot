import {
	type CSSResultGroup,
	css,
	html,
	LitElement,
	type TemplateResult,
} from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("greeting-card")
export class GreetingCard extends LitElement {
	static styles: CSSResultGroup = css`
		p {
			margin: 0;
			font-weight: 600;
		}
	`;

	@property({ type: String })
	accessor name = "World";

	render(): TemplateResult {
		return html`<p>Hello, ${this.name}!</p>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"greeting-card": GreetingCard;
	}
}
