import { groupBy, partition, sortBy, uniqBy } from "lodash";
import type { Role, User } from "./schema";

/** Exercises lodash's large `@types/lodash` declaration surface. */
export function organize(users: User[]): Record<Role, User[]> {
	const unique = uniqBy(users, (u) => u.id);
	const sorted = sortBy(unique, [(u) => u.age, (u) => u.name]);
	const grouped = groupBy(sorted, (u) => u.roles[0] ?? "user");
	return grouped as Record<Role, User[]>;
}

export function splitAdults(users: User[]): [User[], User[]] {
	return partition(users, (u) => u.age >= 18);
}
