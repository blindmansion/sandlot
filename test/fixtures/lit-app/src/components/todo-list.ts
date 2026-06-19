import {
	type CSSResultGroup,
	css,
	html,
	LitElement,
	type TemplateResult,
} from "lit";
import { customElement, property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { pluralize } from "../utils/format";

export interface TodoItem {
	id: number;
	label: string;
	done: boolean;
}

@customElement("todo-list")
export class TodoList extends LitElement {
	static styles: CSSResultGroup = css`
		.done {
			text-decoration: line-through;
			opacity: 0.6;
		}
	`;

	@property({ attribute: false })
	accessor items: TodoItem[] = [];

	private toggle(id: number): void {
		this.items = this.items.map((item) =>
			item.id === id ? { ...item, done: !item.done } : item,
		);
	}

	private get remaining(): number {
		return this.items.filter((item) => !item.done).length;
	}

	render(): TemplateResult {
		return html`
			<p>${pluralize(this.remaining, "item")} remaining</p>
			<ul>
				${repeat(
					this.items,
					(item) => item.id,
					(item) => html`
						<li class=${classMap({ done: item.done })}>
							<label>
								<input
									type="checkbox"
									.checked=${item.done}
									@change=${() => this.toggle(item.id)}
								/>
								${item.label}
							</label>
						</li>
					`,
				)}
			</ul>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"todo-list": TodoList;
	}
}
