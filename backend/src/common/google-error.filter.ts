import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

interface GrpcLikeError {
  code?: number | string;
  message?: string;
}

// Google SDKs surface errors two ways this filter must handle:
//  - Firestore/gax throw google.rpc.Code numbers (7 = PERMISSION_DENIED, ...)
//  - @google-cloud/storage throws ApiError whose `.code` IS the HTTP status
//    number (403/404/401).
// Both are mapped here (the two numeric spaces do not collide).
const CODE_TO_HTTP: Record<number, HttpStatus> = {
  // google.rpc.Code
  5: HttpStatus.NOT_FOUND, // NOT_FOUND
  7: HttpStatus.FORBIDDEN, // PERMISSION_DENIED
  16: HttpStatus.UNAUTHORIZED, // UNAUTHENTICATED
  // HTTP status numbers (Cloud Storage ApiError.code)
  401: HttpStatus.UNAUTHORIZED,
  403: HttpStatus.FORBIDDEN,
  404: HttpStatus.NOT_FOUND,
};

// Some Firebase SDK surfaces use string codes instead of numbers.
const STRING_CODE_TO_HTTP: Record<string, HttpStatus> = {
  'permission-denied': HttpStatus.FORBIDDEN,
  'not-found': HttpStatus.NOT_FOUND,
  unauthenticated: HttpStatus.UNAUTHORIZED,
};

@Catch()
export class GoogleErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(GoogleErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const request = ctx.getRequest<{ url?: string }>();

    // Let Nest's own HttpExceptions pass through untouched.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json(exception.getResponse());
      return;
    }

    const err = exception as GrpcLikeError;
    const mapped =
      typeof err.code === 'number'
        ? CODE_TO_HTTP[err.code]
        : typeof err.code === 'string'
          ? STRING_CODE_TO_HTTP[err.code]
          : undefined;
    const status = mapped ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const isServerError = status === HttpStatus.INTERNAL_SERVER_ERROR;

    if (isServerError) {
      // Log the real error server-side...
      this.logger.error(
        `Unhandled error at ${request.url ?? 'unknown'}: ${err.message ?? exception}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      // ...but never leak an internal error message to the client on a 500.
      // Mapped Google API errors (403/404/401) keep their descriptive message.
      error: isServerError ? 'Internal server error' : (err.message ?? 'Error'),
      path: request.url,
    });
  }
}
