import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface MockUser {
    id: string;
    username: string;
    tier: string;
}

const usersFile = path.resolve(process.env.MOCK_USERS_FILE ?? 'mocks/users.json');

export const getUserTier = async (userId: string): Promise<string> => {
    const users = JSON.parse(await readFile(usersFile, 'utf8')) as MockUser[];
    return users.find((user) => user.id === userId)?.tier ?? 'default';
};
