import {
	type CSSResultGroup,
	css,
	html,
	LitElement,
	type TemplateResult,
} from "lit";

/**
 * A reactive property declared without decorators: `static properties` registers
 * it, `declare` keeps TypeScript happy without emitting a field that would shadow
 * Lit's generated accessor, and the constructor sets the initial value through it.
 */
export class GreetingCard extends LitElement {
	static styles: CSSResultGroup = css`
		p {
			margin: 0;
			font-weight: 600;
		}
	`;

	static properties = {
		name: { type: String },
	};

	declare name: string;

	constructor() {
		super();
		this.name = "World";
	}

	render(): TemplateResult {
		return html`<p>Hello, ${this.name}!</p>`;
	}
}

customElements.define("greeting-card", GreetingCard);

declare global {
	interface HTMLElementTagNameMap {
		"greeting-card": GreetingCard;
	}
}
