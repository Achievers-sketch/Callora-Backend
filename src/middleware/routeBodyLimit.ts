import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

export interface RouteBodyLimitRule {
  method: string;
  route: string;
  limit: string;
}

function normalizeRoute(route: string): string {
  if (!route || route === '/') {
    return '/';
  }

  return route.startsWith('/') ? route : `/${route}`;
}

function isRouteMatch(pathname: string, pattern: string): boolean {
  const normalizedPath = normalizeRoute(pathname);
  const normalizedPattern = normalizeRoute(pattern);

  const pathSegments = normalizedPath.split('/').filter(Boolean);
  const patternSegments = normalizedPattern.split('/').filter(Boolean);

  if (patternSegments.length === 0) {
    return true;
  }

  if (pathSegments.length < patternSegments.length) {
    return false;
  }

  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];

    if (patternSegment === '*') {
      return true;
    }

    if (patternSegment.startsWith(':')) {
      continue;
    }

    if (patternSegment !== pathSegment) {
      return false;
    }
  }

  return true;
}

function isMethodMatch(requestMethod: string, ruleMethod: string): boolean {
  return requestMethod.toUpperCase() === ruleMethod.toUpperCase();
}

export function createRouteBodyLimitMiddleware(rules: RouteBodyLimitRule[] = []): RequestHandler {
  const normalizedRules = rules.map((rule) => ({
    method: rule.method.toUpperCase(),
    route: normalizeRoute(rule.route),
    limit: rule.limit,
  }));

  return (req: Request, res: Response, next: NextFunction) => {
    const matchingRule = normalizedRules.find((rule) =>
      isMethodMatch(req.method, rule.method) && isRouteMatch(req.path, rule.route),
    );

    if (!matchingRule) {
      next();
      return;
    }

    const jsonParser = express.json({ limit: matchingRule.limit });
    const urlEncodedParser = express.urlencoded({ extended: false, limit: matchingRule.limit });

    jsonParser(req, res, (jsonError) => {
      if (jsonError) {
        next(jsonError);
        return;
      }

      urlEncodedParser(req, res, next);
    });
  };
}
