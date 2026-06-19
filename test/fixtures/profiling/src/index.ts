import { parseUser, type User } from "./schema";
import { adultNames } from "./stream";
import { organize, splitAdults } from "./users";

export async function run(raw: unknown[]): Promise<void> {
	const users: User[] = raw.map(parseUser);
	const grouped = organize(users);
	const [adults, minors] = splitAdults(users);
	const names = await adultNames(users);
	console.log(Object.keys(grouped), adults.length, minors.length, names);
}
