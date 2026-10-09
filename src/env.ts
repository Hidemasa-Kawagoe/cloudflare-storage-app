export interface SessionUser {
	id: string;
	displayName: string;
	email: string;
	isAdmin: boolean;
}

export interface SessionData {
	userId: string;
	csrf: string;
	createdAt: string;
}

export type AppEnv = {
	Bindings: Env;
	Variables: { user: SessionUser; session: SessionData; sessionId: string };
};
