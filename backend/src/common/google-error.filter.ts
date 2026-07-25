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

// google.rpc.Code -> HTTP status for the codes ADC misconfig produces.
const GRPC_CODE_TO_HTTP: Record<number, HttpStatus> = {
  5: HttpStatus.NOT_FOUND, // NOT_FOUND
  7: HttpStatus.FORBIDDEN, // PERMISSION_DENIED
  16: HttpStatus.UNAUTHORIZED, // UNAUTHENTICATED
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
    const status =
      typeof err.code === 'number' && GRPC_CODE_TO_HTTP[err.code]
        ? GRPC_CODE_TO_HTTP[err.code]
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled error at ${request.url ?? 'unknown'}: ${err.message ?? exception}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      error: err.message ?? 'Internal server error',
      path: request.url,
    });
  }
}
