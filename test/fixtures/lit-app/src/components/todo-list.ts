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

	// Controlled component: the owner of `items` reacts to this event and pushes
	// down the updated list. Toggling local state here would be clobbered the
	// next time the owner re-renders (Lit re-commits object props every render).
	private toggle(id: number): void {
		this.dispatchEvent(
			new CustomEvent<number>("toggle-item", {
				detail: id,
				bubbles: true,
				composed: true,
			}),
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
