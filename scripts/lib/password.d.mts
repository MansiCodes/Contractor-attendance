export function hashPassword(password: string): Promise<string>;
export const MIN_PASSWORD_LENGTH: number;
export function promptHidden(question: string): Promise<string>;
