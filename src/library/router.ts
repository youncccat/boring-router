import {Action, History, Location, locationsAreEqual, parsePath} from 'history';
import hyphenate from 'hyphenate';
import {extendObservable, observable} from 'mobx';

import {then} from './@utils';
import {
  GeneralQueryDict,
  MatchingRouteMatch,
  RouteMatch,
  RouteMatchOptions,
} from './route-match';
import {RouteSchemaDict} from './schema';

export type FragmentMatcherCallback = (key: string) => string;

const DEFAULT_FRAGMENT_MATCHER_CALLBACK: FragmentMatcherCallback = key =>
  hyphenate(key, {lowerCase: true});

type RouteQuerySchemaType<TRouteSchema> = TRouteSchema extends {
  $query: infer TQuerySchema;
}
  ? TQuerySchema
  : never;

type FilterRouteMatchNonStringFragment<TRouteSchema, T> = TRouteSchema extends {
  $match: infer TMatch;
}
  ? TMatch extends string ? never : T
  : never;

interface RouteSchemaChildrenSection<TRouteSchemaDict> {
  $children: TRouteSchemaDict;
}

export type NestedRouteSchemaDictType<
  TRouteSchema
> = TRouteSchema extends RouteSchemaChildrenSection<
  infer TNestedRouteSchemaDict
>
  ? TNestedRouteSchemaDict
  : {};

interface RouteSchemaExtensionSection<TRouteMatchExtension> {
  $extension: TRouteMatchExtension;
}

export type RouteMatchExtensionType<
  TRouteSchema
> = TRouteSchema extends RouteSchemaExtensionSection<infer TRouteMatchExtension>
  ? TRouteMatchExtension
  : {};

export type RouteMatchFragmentType<
  TRouteSchemaDict,
  TFragmentKey extends string
> = {
  [K in Extract<keyof TRouteSchemaDict, string>]: RouteMatchType<
    TRouteSchemaDict[K],
    TFragmentKey | FilterRouteMatchNonStringFragment<TRouteSchemaDict[K], K>
  >
};

export type RouteMatchType<
  TRouteSchema,
  TFragmentKey extends string
> = RouteMatch<
  Record<
    Extract<keyof RouteQuerySchemaType<TRouteSchema>, string>,
    string | undefined
  > &
    {[K in TFragmentKey]: string}
> &
  RouteMatchFragmentType<
    NestedRouteSchemaDictType<TRouteSchema>,
    TFragmentKey
  > &
  RouteMatchExtensionType<TRouteSchema>;

export type RouterType<TRouteSchemaDict> = Router &
  RouteMatchFragmentType<TRouteSchemaDict, never>;

export interface RouteMatchEntry {
  match: RouteMatch;
  exact: boolean;
  fragment: string;
}

export interface RouteSource {
  matchToMatchEntryMap: Map<RouteMatch, RouteMatchEntry>;
  queryDict: GeneralQueryDict;
}

export interface RouterOptions {
  /**
   * A function to perform default schema field name to fragment string
   * transformation.
   */
  fragmentMatcher?: FragmentMatcherCallback;
  /** Default path on error. */
  default?: string;
}

export class Router {
  /** @internal */
  private _history: History;

  /** @internal */
  private _fragmentMatcher: FragmentMatcherCallback;

  /** @internal */
  private _location: Location;

  /** @internal */
  private _source: RouteSource = observable({
    matchToMatchEntryMap: new Map(),
    queryDict: {},
  });

  /** @internal */
  @observable
  private _matchingSource: RouteSource = observable({
    matchToMatchEntryMap: new Map(),
    queryDict: {},
  });

  /** @internal */
  _children: RouteMatch[];

  private constructor(
    schema: RouteSchemaDict,
    history: History,
    {fragmentMatcher, default: defaultPath = '/'}: RouterOptions,
  ) {
    this._history = history;
    this._location = parsePath(defaultPath);

    this._fragmentMatcher =
      fragmentMatcher || DEFAULT_FRAGMENT_MATCHER_CALLBACK;

    this._children = this._build(schema, this);

    then(() => {
      history.listen(this._onLocationChange);
      this._onLocationChange(history.location, 'POP');
    });
  }

  /** @internal */
  private _onLocationChange = (
    {pathname, search}: Location,
    action: Action,
  ): void => {
    let history = this._history;
    let location = history.location;

    if (locationsAreEqual(this._location, location)) {
      return;
    }

    let searchParams = new URLSearchParams(search);

    let queryDict = Array.from(searchParams).reduce(
      (dict, [key, value]) => {
        dict[key] = value;
        return dict;
      },
      {} as GeneralQueryDict,
    );

    let routeMatchEntries = this._match(this, pathname) || [];

    let matchToMatchEntryMap = new Map(
      routeMatchEntries.map(
        (entry): [RouteMatch, RouteMatchEntry] => [entry.match, entry],
      ),
    );

    Object.assign(this._matchingSource, {
      matchToMatchEntryMap,
      queryDict,
    });

    // Prepare previous/next match set

    let previousMatchSet = new Set(this._source.matchToMatchEntryMap.keys());
    let nextMatchSet = new Set(matchToMatchEntryMap.keys());

    let leavingMatchSet = new Set(previousMatchSet);

    for (let match of nextMatchSet) {
      leavingMatchSet.delete(match);
    }

    let enteringMatchSet = new Set(nextMatchSet);

    for (let match of previousMatchSet) {
      enteringMatchSet.delete(match);
    }

    // Process before hooks

    for (let match of Array.from(leavingMatchSet).reverse()) {
      let result = match._beforeLeave();

      if (!result) {
        this._revert(action);
        return;
      }
    }

    for (let match of enteringMatchSet) {
      let result = match._beforeEnter();

      if (typeof result === 'string') {
        history.replace(result);
        return;
      }

      if (!result) {
        this._revert(action);
        return;
      }
    }

    this._location = location;

    Object.assign(this._source, this._matchingSource);

    // Update

    for (let match of leavingMatchSet) {
      match._update(false, false);
    }

    for (let match of nextMatchSet) {
      let {exact} = matchToMatchEntryMap.get(match)!;
      match._update(true, exact);
    }

    // Process after hooks

    for (let match of leavingMatchSet) {
      match._afterLeave();
    }

    for (let match of enteringMatchSet) {
      match._afterEnter();
    }
  };

  private _revert(action: Action): void {
    let history = this._history;
    let location = this._location;

    switch (action) {
      case 'PUSH':
        history.goBack();
        break;
      case 'POP':
      case 'REPLACE':
        history.replace(location);
        break;
    }
  }

  /** @internal */
  private _match(
    target: Router | RouteMatch,
    upperRest: string,
  ): RouteMatchEntry[] | undefined {
    for (let routeMatch of target._children || []) {
      let {matched, exactlyMatched, fragment, rest} = routeMatch._match(
        upperRest,
      );

      if (!matched) {
        continue;
      }

      if (exactlyMatched) {
        return [
          {
            match: routeMatch,
            fragment: fragment!,
            exact: true,
          },
        ];
      }

      let result = this._match(routeMatch, rest);

      if (!result) {
        continue;
      }

      return [
        {
          match: routeMatch,
          fragment: fragment!,
          exact: false,
        },
        ...result,
      ];
    }

    return undefined;
  }

  /** @internal */
  private _build(
    schemaDict: RouteSchemaDict,
    parent: RouteMatch | Router,
    matchingParent?: MatchingRouteMatch,
  ): RouteMatch[] {
    let routeMatches: RouteMatch[] = [];

    let source = this._source;
    let matchingSource = this._matchingSource;
    let history = this._history;

    for (let [key, schema] of Object.entries(schemaDict)) {
      if (typeof schema === 'boolean') {
        schema = {};
      }

      let {
        $match: match = this._fragmentMatcher(key),
        $query: query,
        $exact: exact = false,
        $children: children,
        $extension: extension = {},
      } = schema;

      let options: RouteMatchOptions = {
        match,
        query,
        exact,
      };

      let routeMatch = new RouteMatch(
        key,
        source,
        parent instanceof RouteMatch ? parent : undefined,
        history,
        options,
      );

      extendObservable(routeMatch, extension);

      let matchingRouteMatch = new MatchingRouteMatch(
        key,
        matchingSource,
        matchingParent,
        routeMatch,
        history,
        options,
      );

      for (let key of Object.keys(extension)) {
        Object.defineProperty(matchingRouteMatch, key, {
          get() {
            return (routeMatch as any)[key];
          },
          set(value) {
            (routeMatch as any)[key] = value;
          },
        });
      }

      routeMatch._matching = matchingRouteMatch;

      routeMatches.push(routeMatch);

      (parent as any)[key] = routeMatch;

      if (matchingParent) {
        (matchingParent as any)[key] = matchingRouteMatch;
      }

      if (!children) {
        continue;
      }

      routeMatch._children = this._build(
        children,
        routeMatch,
        matchingRouteMatch,
      );
    }

    return routeMatches;
  }

  static create<TSchema extends RouteSchemaDict>(
    schema: TSchema,
    history: History,
    options: RouterOptions = {},
  ): RouterType<TSchema> {
    return new Router(schema, history, options) as RouterType<TSchema>;
  }
}
