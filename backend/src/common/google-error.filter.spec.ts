import {
  ArgumentsHost,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
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

  it('maps a Storage HTTP-status code (403) to 403', () => {
    const { host, status } = fakeHost();
    filter.catch({ code: 403, message: 'Forbidden' }, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('maps a Storage HTTP-status code (404) to 404', () => {
    const { host, status } = fakeHost();
    filter.catch({ code: 404, message: 'Not Found' }, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('maps a string code (permission-denied) to 403', () => {
    const { host, status } = fakeHost();
    filter.catch({ code: 'permission-denied', message: 'denied' }, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('defaults unknown errors to 500 without leaking the internal message', () => {
    const { host, status, json } = fakeHost();
    filter.catch(new Error('boom'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Internal server error',
        path: '/demo/firestore',
      }),
    );
  });

  it('passes Nest HttpExceptions through untouched', () => {
    const { host, status, json } = fakeHost();
    const exception = new NotFoundException('no such thing');
    filter.catch(exception, host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(exception.getResponse());
  });
});
