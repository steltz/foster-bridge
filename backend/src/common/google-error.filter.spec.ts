import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { GoogleErrorFilter } from './google-error.filter';

describe('GoogleErrorFilter', () => {
  const filter = new GoogleErrorFilter();

  function fakeHost() {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: '/demo/firestore' }),
      }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  it('maps permission-denied to 403', () => {
    const { host, status } = fakeHost();
    filter.catch({ code: 7, message: 'PERMISSION_DENIED' }, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('maps unauthenticated to 401', () => {
    const { host, status } = fakeHost();
    filter.catch({ code: 16, message: 'UNAUTHENTICATED' }, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
  });

  it('maps not-found to 404', () => {
    const { host, status } = fakeHost();
    filter.catch({ code: 5, message: 'NOT_FOUND' }, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('defaults unknown errors to 500', () => {
    const { host, status } = fakeHost();
    filter.catch(new Error('boom'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
