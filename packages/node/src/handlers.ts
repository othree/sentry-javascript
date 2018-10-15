import { getCurrentHub } from '@sentry/core';
import { Carrier, Hub } from '@sentry/hub';
import { SentryEvent } from '@sentry/types';
import { forget } from '@sentry/utils/async';
import { logger } from '@sentry/utils/logger';
import { serialize } from '@sentry/utils/object';
import * as cookie from 'cookie';
import * as domain from 'domain';
import * as http from 'http';
import * as os from 'os';
import * as url from 'url';
import { NodeClient } from './client';

const DEFAULT_SHUTDOWN_TIMEOUT = 2000;

type TransactionTypes = 'path' | 'methodPath' | 'handler';

/** JSDoc */
function extractTransaction(req: { [key: string]: any }, type: boolean | TransactionTypes): string | undefined {
  try {
    // Express.js shape
    const request = req as {
      method: string;
      route: {
        path: string;
        stack: [
          {
            name: string;
          }
        ];
      };
    };

    switch (type) {
      case 'path': {
        return request.route.path;
      }
      case 'handler': {
        return request.route.stack[0].name;
      }
      case 'methodPath':
      default: {
        const method = request.method.toUpperCase();
        const path = request.route.path;
        return `${method}|${path}`;
      }
    }
  } catch (_oO) {
    return undefined;
  }
}

/** JSDoc */
function extractRequestData(req: { [key: string]: any }): { [key: string]: string } {
  // headers:
  //   node, express: req.headers
  //   koa: req.header
  const headers = (req.headers || req.header || {}) as {
    host?: string;
    cookie?: string;
  };
  // method:
  //   node, express, koa: req.method
  const method = req.method;
  // host:
  //   express: req.hostname in > 4 and req.host in < 4
  //   koa: req.host
  //   node: req.headers.host
  const host = req.hostname || req.host || headers.host || '<no host>';
  // protocol:
  //   node: <n/a>
  //   express, koa: req.protocol
  const protocol =
    req.protocol === 'https' || req.secure || ((req.socket || {}) as { encrypted?: boolean }).encrypted
      ? 'https'
      : 'http';
  // url (including path and query string):
  //   node, express: req.originalUrl
  //   koa: req.url
  const originalUrl = (req.originalUrl || req.url) as string;
  // absolute url
  const absoluteUrl = `${protocol}://${host}${originalUrl}`;
  // query string:
  //   node: req.url (raw)
  //   express, koa: req.query
  const query = req.query || url.parse(originalUrl || '', true).query;
  // cookies:
  //   node, express, koa: req.headers.cookie
  const cookies = cookie.parse(headers.cookie || '');
  // body data:
  //   node, express, koa: req.body
  let data = req.body;
  if (method === 'GET' || method === 'HEAD') {
    if (typeof data === 'undefined') {
      data = '<unavailable>';
    }
  }
  if (data && typeof data !== 'string' && {}.toString.call(data) !== '[object String]') {
    // Make sure the request body is a string
    data = serialize(data);
  }

  // request interface
  const request: {
    [key: string]: any;
  } = {
    cookies,
    data,
    headers,
    method,
    query_string: query,
    url: absoluteUrl,
  };

  return request;
}

/** Default user keys that'll be used to extract data from the request */
const DEFAULT_USER_KEYS = ['id', 'username', 'email'];

/** JSDoc */
function extractUserData(req: { [key: string]: any }, keys: boolean | string[]): { [key: string]: string } {
  const user: { [key: string]: string } = {};
  const attributes = Array.isArray(keys) ? keys : DEFAULT_USER_KEYS;

  attributes.forEach(key => {
    if ({}.hasOwnProperty.call(req.user, key)) {
      user[key] = (req.user as { [key: string]: string })[key];
    }
  });

  // client ip:
  //   node: req.connection.remoteAddress
  //   express, koa: req.ip
  const ip =
    req.ip ||
    (req.connection &&
      (req.connection as {
        remoteAddress?: string;
      }).remoteAddress);

  if (ip) {
    user.ip_address = ip as string;
  }

  return user;
}

/** JSDoc */
function parseRequest(
  event: SentryEvent,
  req: {
    [key: string]: any;
  },
  options?: {
    request?: boolean;
    serverName?: boolean;
    transaction?: boolean | TransactionTypes;
    user?: boolean | string[];
    version?: boolean;
  },
): SentryEvent {
  // tslint:disable-next-line:no-parameter-reassignment
  options = {
    request: true,
    serverName: true,
    transaction: true,
    user: true,
    version: true,
    ...options,
  };

  if (options.version) {
    event.extra = {
      ...event.extra,
      node: global.process.version,
    };
  }

  if (options.request) {
    event.request = {
      ...event.request,
      ...extractRequestData(req),
    };
  }

  if (options.serverName) {
    event.server_name = global.process.env.SENTRY_NAME || os.hostname();
  }

  if (options.user && req.user) {
    event.user = {
      ...event.user,
      ...extractUserData(req, options.user),
    };
  }

  if (options.transaction) {
    const transaction = extractTransaction(req, options.transaction);
    if (transaction) {
      event.transaction = transaction;
    }
  }

  return event;
}

/** Domain interface with attached Hub */
interface SentryDomain extends NodeJS.Domain {
  __SENTRY__?: Carrier;
}

/** JSDoc */
export function requestHandler(options?: {
  request?: boolean;
  serverName?: boolean;
  transaction?: boolean | TransactionTypes;
  user?: boolean | string[];
  version?: boolean;
}): (req: http.IncomingMessage, res: http.ServerResponse, next: (error?: any) => void) => void {
  return function sentryRequestMiddleware(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (error?: any) => void,
  ): void {
    const alreadyRunningDomain = process.domain as SentryDomain;
    let alreadyRunningDomainHub: Hub | undefined;

    if (alreadyRunningDomain) {
      if (alreadyRunningDomain.__SENTRY__) {
        alreadyRunningDomainHub = alreadyRunningDomain.__SENTRY__.hub;
      }
    }

    const local = domain.create() as SentryDomain;
    local.add(req);
    local.add(res);
    local.on('error', next);
    local.run(() => {
      if (alreadyRunningDomainHub) {
        local.__SENTRY__ = {
          hub: alreadyRunningDomainHub,
        };
      }
      getCurrentHub().configureScope(scope =>
        scope.addEventProcessor(async (event: SentryEvent) => parseRequest(event, req, options)),
      );
      next();
    });
  };
}

/** JSDoc */
interface MiddlewareError extends Error {
  status?: number | string;
  statusCode?: number | string;
  status_code?: number | string;
  output?: {
    statusCode?: number | string;
  };
}

/** JSDoc */
function getStatusCodeFromResponse(error: MiddlewareError): number {
  const statusCode = error.status || error.statusCode || error.status_code || (error.output && error.output.statusCode);
  return statusCode ? parseInt(statusCode as string, 10) : 500;
}

/** JSDoc */
export function errorHandler(): (
  error: MiddlewareError,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (error: MiddlewareError) => void,
) => void {
  return function sentryErrorMiddleware(
    error: MiddlewareError,
    _req: http.IncomingMessage,
    _res: http.ServerResponse,
    next: (error: MiddlewareError) => void,
  ): void {
    const status = getStatusCodeFromResponse(error);
    if (status < 500) {
      next(error);
      return;
    }
    getCurrentHub().captureException(error, { originalException: error });
    next(error);
  };
}

/** JSDoc */
export function defaultOnFatalError(error: Error): void {
  console.error(error && error.stack ? error.stack : error);
  const options = (getCurrentHub().getClient() as NodeClient).getOptions();
  const timeout =
    (options && options.shutdownTimeout && options.shutdownTimeout > 0 && options.shutdownTimeout) ||
    DEFAULT_SHUTDOWN_TIMEOUT;
  forget(
    (getCurrentHub().getClient() as NodeClient).close(timeout).then((result: boolean) => {
      if (!result) {
        logger.warn('We reached the timeout for emptying the request buffer, still exiting now!');
      }
      global.process.exit(1);
    }),
  );
}
