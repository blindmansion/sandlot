import { z } from "zod";

/**
 * A non-trivial zod schema. zod's inference is deliberately heavy on the
 * type-checker, which makes it a good stress test for the typecheck pipeline.
 */
export const UserSchema = z.object({
	id: z.string().uuid(),
	name: z.string().min(1),
	age: z.number().int().nonnegative(),
	email: z.string().email(),
	roles: z.array(z.enum(["admin", "user", "guest"])),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export type User = z.infer<typeof UserSchema>;
export type Role = User["roles"][number];

export function parseUser(input: unknown): User {
	return UserSchema.parse(input);
}
