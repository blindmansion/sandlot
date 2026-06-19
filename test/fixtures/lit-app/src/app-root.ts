import {
	type CSSResultGroup,
	css,
	html,
	LitElement,
	type TemplateResult,
} from "lit";
import "./components/greeting-card";
import "./components/counter-button";
import "./components/todo-list";
import { ClockController } from "./controllers/clock-controller";
import type { TodoItem } from "./components/todo-list";

const SEED_TODOS: TodoItem[] = [
	{ id: 1, label: "Wire up the bundler", done: true },
	{ id: 2, label: "Profile the typechecker", done: false },
	{ id: 3, label: "Ship the widget", done: false },
];

export class AppRoot extends LitElement {
	static styles: CSSResultGroup = css`
		:host {
			display: block;
			font-family: system-ui, sans-serif;
		}
		h1 {
			font-size: 1.25rem;
		}
	`;

	static properties = {
		expanded: { state: true },
	};

	declare expanded: boolean;
	private readonly clock = new ClockController(this);

	constructor() {
		super();
		this.expanded = true;
	}

	private toggle(): void {
		this.expanded = !this.expanded;
	}

	render(): TemplateResult {
		return html`
			<h1>Lit widgets</h1>
			<small>${this.clock.value.toLocaleTimeString()}</small>
			<greeting-card name="world"></greeting-card>
			<button type="button" @click=${this.toggle}>
				${this.expanded ? "Hide" : "Show"} widgets
			</button>
			${this.expanded
				? html`
						<counter-button .step=${2}></counter-button>
						<todo-list .items=${SEED_TODOS}></todo-list>
					`
				: null}
		`;
	}
}

customElements.define("app-root", AppRoot);

declare global {
	interface HTMLElementTagNameMap {
		"app-root": AppRoot;
	}
}
