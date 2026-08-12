export const config = {
  server: { apiVersion: 'v1' },
};

export const adminServiceKey = process.env.ADMIN_SERVICE_KEY ?? 'test-service-key';
export const userServiceKey = process.env.USER_SERVICE_KEY ?? 'test-user-key';
export const authServiceUrl = process.env.AUTH_SERVICE_URL ?? 'http://localhost:8001';
export const unknownValue = process.env.UNKNOWN_VALUE ?? 'AKIA1234567890123456';
