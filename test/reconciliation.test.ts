import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
    ALLOWED_UPLOAD_USERS,
    extractAuthToken,
    extractUserIdentity,
    isUserAuthorizedForUpload,
    getJwtSecret,
    type JwtUserPayload
} from '../src/routes/board.js';
import { parsePRPointsResponse } from '../src/routes/ws.js';
import { getAllowedOrigins, DEFAULT_ALLOWED_ORIGIN } from '../src/config/cors.js';

const TEST_SECRET = 'synthetic-test-jwt-secret-xyz-12345';

describe('Production Reconciliation Tests', () => {
    describe('CORS Configuration', () => {
        it('includes production frontend origin https://events.geekhaven.in by default', () => {
            const origins = getAllowedOrigins(undefined);
            assert.strictEqual(origins.includes('https://events.geekhaven.in'), true);
            assert.strictEqual(origins.includes('http://localhost:3000'), true);
        });

        it('includes production frontend origin when production FRONTEND_URL is set', () => {
            const origins = getAllowedOrigins('https://events.geekhaven.in');
            assert.strictEqual(origins.length, 1);
            assert.strictEqual(origins[0], 'https://events.geekhaven.in');
        });

        it('includes both production and custom origin when custom FRONTEND_URL is set', () => {
            const origins = getAllowedOrigins('https://custom.geekhaven.in');
            assert.strictEqual(origins.includes('https://events.geekhaven.in'), true);
            assert.strictEqual(origins.includes('https://custom.geekhaven.in'), true);
        });

        it('does not allow arbitrary wildcard origins', () => {
            const origins = getAllowedOrigins('https://events.geekhaven.in');
            assert.strictEqual(origins.includes('*'), false);
        });
    });

    describe('Board Upload Authentication & Authorization', () => {
        // Test 1: Valid JWT for Coldesy
        it('Test 1: Valid JWT for Coldesy is verified and authorized', () => {
            const token = jwt.sign(
                { id: 'Coldesy', githubId: 'Coldesy', roles: { isAdmin: true } },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const payload = jwt.verify(token, TEST_SECRET) as JwtUserPayload;
            const userId = extractUserIdentity(payload);

            assert.strictEqual(userId, 'Coldesy');
            assert.strictEqual(isUserAuthorizedForUpload(userId), true);
        });

        // Test 2: Valid JWT for 0xshellghost
        it('Test 2: Valid JWT for 0xshellghost is verified and authorized', () => {
            const token = jwt.sign(
                { id: '0xshellghost', githubId: '0xshellghost', roles: { isAdmin: true } },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const payload = jwt.verify(token, TEST_SECRET) as JwtUserPayload;
            const userId = extractUserIdentity(payload);

            assert.strictEqual(userId, '0xshellghost');
            assert.strictEqual(isUserAuthorizedForUpload(userId), true);
        });

        // Test 3: Valid JWT for an unauthorized user
        it('Test 3: Valid JWT for an unauthorized user is rejected with false', () => {
            const token = jwt.sign(
                { id: 'regular-user-123', githubId: 'regular-user-123' },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const payload = jwt.verify(token, TEST_SECRET) as JwtUserPayload;
            const userId = extractUserIdentity(payload);

            assert.strictEqual(userId, 'regular-user-123');
            assert.strictEqual(isUserAuthorizedForUpload(userId), false);
        });

        // Test 4: JWT with a database ID and username as separate claims
        it('Test 4: Correctly prioritizes username/githubId over database UUID', () => {
            const token = jwt.sign(
                {
                    id: 'usr_db_a1b2c3d4-e5f6-7890-abcd-ef0123456789',
                    githubId: 'Coldesy',
                    username: 'Coldesy'
                },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const payload = jwt.verify(token, TEST_SECRET) as JwtUserPayload;
            const userId = extractUserIdentity(payload);

            // Must NOT mistakenly treat internal UUID as the username
            assert.strictEqual(userId, 'Coldesy');
            assert.strictEqual(isUserAuthorizedForUpload(userId), true);
        });

        // Test 5: Missing JWT
        it('Test 5: Missing JWT returns undefined token', () => {
            const token = extractAuthToken(undefined, undefined);
            assert.strictEqual(token, undefined);

            const emptyToken = extractAuthToken('', '');
            assert.strictEqual(emptyToken, undefined);
        });

        // Test 6: Invalid JWT
        it('Test 6: Invalid / tampered JWT throws verification error', () => {
            const validToken = jwt.sign({ id: 'Coldesy' }, TEST_SECRET);
            const tamperedToken = validToken + 'tampered';

            assert.throws(() => {
                jwt.verify(tamperedToken, TEST_SECRET);
            }, jwt.JsonWebTokenError);

            assert.throws(() => {
                jwt.verify('not.a.valid.jwt.token', TEST_SECRET);
            }, jwt.JsonWebTokenError);

            assert.throws(() => {
                jwt.verify(validToken, 'wrong-secret-key-999');
            }, jwt.JsonWebTokenError);
        });

        // Test 7: Expired JWT
        it('Test 7: Expired JWT throws TokenExpiredError', () => {
            const expiredToken = jwt.sign(
                { id: 'Coldesy', githubId: 'Coldesy' },
                TEST_SECRET,
                { expiresIn: '-10s' }
            );

            assert.throws(() => {
                jwt.verify(expiredToken, TEST_SECRET);
            }, jwt.TokenExpiredError);
        });

        // Test 8: Missing production JWT secret fails closed
        it('Test 8: Missing production JWT secret fails closed without fallback to monster', () => {
            const prevSecret = process.env.JWT_SECRET;
            const prevJwt = process.env.JWT;

            try {
                delete process.env.JWT_SECRET;
                delete process.env.JWT;

                const secret = getJwtSecret();
                assert.strictEqual(secret, undefined);
                assert.notStrictEqual(secret, 'monster');
            } finally {
                if (prevSecret) process.env.JWT_SECRET = prevSecret;
                if (prevJwt) process.env.JWT = prevJwt;
            }
        });

        // Test 9: Bearer header authentication
        it('Test 9: Extracts token from Authorization: Bearer <token> header', () => {
            const token = extractAuthToken('Bearer test-token-12345', undefined);
            assert.strictEqual(token, 'test-token-12345');
        });

        // Test 10: Cookie authentication
        it('Test 10: Extracts token from cookie when header is absent', () => {
            const token = extractAuthToken(undefined, 'test-cookie-token-67890');
            assert.strictEqual(token, 'test-cookie-token-67890');
        });

        // Test 11: Both authentication methods supplied together (Bearer header takes precedence)
        it('Test 11: Prefers Bearer header when both header and cookie are present', () => {
            const token = extractAuthToken('Bearer priority-header-token', 'fallback-cookie-token');
            assert.strictEqual(token, 'priority-header-token');
        });

        // Verify ALLOWED_UPLOAD_USERS list
        it('includes exactly Coldesy and 0xshellghost in ALLOWED_UPLOAD_USERS', () => {
            assert.strictEqual(ALLOWED_UPLOAD_USERS.includes('Coldesy'), true);
            assert.strictEqual(ALLOWED_UPLOAD_USERS.includes('0xshellghost'), true);
            assert.strictEqual(ALLOWED_UPLOAD_USERS.length, 2);
        });
    });

    describe('PR Points Response Parsing & Normalization', () => {
        it('correctly extracts points from actual GeekHaven API object format', () => {
            const apiResponse = {
                status: 'OK',
                message: 'OK',
                data: {
                    name: 'Harshvardhan Bansal',
                    githubId: 'HARSH4885-svg',
                    gender: 'male',
                    year: '1st Year',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/208810293?v=4',
                    PR: [],
                    points: 230,
                    prMerged: 22
                }
            };

            const points = parsePRPointsResponse(apiResponse);
            assert.strictEqual(points, 230);
            assert.strictEqual(typeof points, 'number');
            assert.strictEqual(Number.isFinite(points), true);
        });

        it('supports legacy numeric format if returned by API', () => {
            const legacyResponse = {
                status: 'OK',
                message: 'OK',
                data: 150
            };

            const points = parsePRPointsResponse(legacyResponse);
            assert.strictEqual(points, 150);
        });

        it('safely handles missing or zero points', () => {
            const zeroResponse = {
                status: 'OK',
                data: {
                    points: 0
                }
            };
            assert.strictEqual(parsePRPointsResponse(zeroResponse), 0);
        });

        it('safely handles null, undefined, and non-object responses without throwing', () => {
            assert.strictEqual(parsePRPointsResponse(null), 0);
            assert.strictEqual(parsePRPointsResponse(undefined), 0);
            assert.strictEqual(parsePRPointsResponse('invalid string'), 0);
            assert.strictEqual(parsePRPointsResponse(12345), 0);
            assert.strictEqual(parsePRPointsResponse({}), 0);
            assert.strictEqual(parsePRPointsResponse({ data: null }), 0);
            assert.strictEqual(parsePRPointsResponse({ data: {} }), 0);
            assert.strictEqual(parsePRPointsResponse({ data: { points: 'not-a-number' } }), 0);
            assert.strictEqual(parsePRPointsResponse({ data: { points: NaN } }), 0);
            assert.strictEqual(parsePRPointsResponse({ data: { points: Infinity } }), 0);
        });
    });
});
