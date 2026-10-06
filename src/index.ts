/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { DOMParser } from '@xmldom/xmldom';

export interface Env {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;
}

async function* listAll(bucket: R2Bucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	do {
		var r2_objects = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2_objects.objects) {
			yield object;
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);
}

/**
 * A direct member of a WebDAV collection.
 *
 * `collection` covers both explicit collections (a marker object written by
 * MKCOL) and implicit ones that only exist as a key prefix.
 */
type DavMember = { kind: 'object'; object: R2Object } | { kind: 'collection'; key: string };

/**
 * Lists the direct members of a collection, including implicit collections.
 *
 * R2 has no directories: a key such as `photos/deep.txt` written straight into
 * the bucket (dashboard, S3 API, `wrangler r2 object put`) implies the
 * collection `photos/` even though no marker object was ever created for it.
 * RFC 4918 §5.2 requires that collection to exist:
 * "For all WebDAV-compliant resources A and B ... such that "V" is equal to
 * "U/SEGMENT", A MUST be a collection that contains a mapping from "SEGMENT"
 * to B." R2 returns those as `delimitedPrefixes`, which listAll() discards, so
 * this function exists separately: listAll() is still used by the recursive
 * LOCK / COPY / MOVE paths that must only ever see real R2 objects.
 *
 * `prefix` is either '' (the root collection) or a path ending with '/'.
 */
async function* listMembers(bucket: R2Bucket, prefix: string): AsyncGenerator<DavMember> {
	let cursor: string | undefined = undefined;
	// Path segments already reported, so that RFC 4918 §5.2 ("A collection MUST
	// contain at most one mapping for a given path segment") holds even when a
	// key is both a marker object and a key prefix.
	let seen = new Set<string>();
	do {
		let page = await bucket.list({
			prefix: prefix,
			delimiter: '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		// Objects first so that a marker object (explicit collection) and a plain
		// object always win over a same-named implicit collection.
		for (let object of page.objects) {
			if (seen.has(object.key)) {
				continue;
			}
			seen.add(object.key);

			if (object.customMetadata?.resourcetype === '<collection />') {
				yield { kind: 'collection', key: object.key };
			} else {
				yield { kind: 'object', object: object };
			}
		}

		for (let delimitedPrefix of page.delimitedPrefixes) {
			let key = delimitedPrefix.endsWith('/') ? delimitedPrefix.slice(0, -1) : delimitedPrefix;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			yield { kind: 'collection', key: key };
		}

		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
}

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
	supportedlock: string;
	lockdiscovery: string;
};

type LockDetails = {
	token: string;
	owner: string | undefined;
	scope: 'exclusive' | 'shared';
	depth: '0' | 'infinity';
	timeout: string;
	expiresAt: number;
	root: string;
};

type DeadProperty = {
	namespaceURI: string;
	localName: string;
	prefix: string | null;
	valueXml: string;
};

type PropfindRequest =
	| {
			mode: 'allprop';
	  }
	| {
			mode: 'propname';
	  }
	| {
			mode: 'prop';
			properties: DeadProperty[];
	  };

type ProppatchOperation = {
	action: 'set' | 'remove';
	property: DeadProperty;
};

const DEFAULT_LOCK_TIMEOUT = 3600;
const MAX_LOCK_TIMEOUT = 365 * 24 * 60 * 60;
const VALID_LOCK_DEPTHS = ['0', 'infinity'] as const;
const LOCK_METADATA_KEYS = [
	'lock_token',
	'lock_owner',
	'lock_scope',
	'lock_depth',
	'lock_timeout',
	'lock_expires_at',
	'lock_root',
	'lock_records',
];
const INTERNAL_DELETE_FORWARD_HEADERS = ['If', 'Lock-Token'] as const;
const RAW_XML_DAV_PROPERTIES = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);
const DAV_NAMESPACE = 'DAV:';
const DEAD_PROPERTY_PREFIX = 'dead_property:';
const LOCK_RECORDS_METADATA_KEY = 'lock_records';

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function getResourceHref(key: string, isCollection: boolean): string {
	const encodeHrefPath = (href: string): string => {
		if (href === '/') {
			return '/';
		}
		return href
			.split('/')
			.map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
			.join('/');
	};

	if (key === '') {
		return '/';
	}
	return encodeHrefPath(`/${key + (isCollection ? '/' : '')}`);
}

function decodeResourcePath(pathname: string): string {
	let resourcePath = pathname.slice(1);
	resourcePath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	if (resourcePath === '') {
		return '';
	}
	return resourcePath
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join('/');
}

function getParentPath(resourcePath: string): string {
	let normalizedPath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	return normalizedPath.split('/').slice(0, -1).join('/');
}

async function hasCollectionResource(bucket: R2Bucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}

	let resource = await bucket.head(resourcePath);
	if (resource !== null) {
		return resource.customMetadata?.resourcetype === '<collection />';
	}

	let descendants = await bucket.list({
		prefix: resourcePath + '/',
		limit: 1,
	});
	return descendants.objects.length > 0;
}

/**
 * Writes the marker object that represents an explicit collection.
 *
 * Uses the same representation as MKCOL: an empty object whose key is the
 * collection path without the trailing slash and whose `resourcetype`
 * custom metadata marks it as a collection.
 */
async function writeCollectionMarker(bucket: R2Bucket, resourcePath: string): Promise<void> {
	await bucket.put(resourcePath, new Uint8Array(), {
		customMetadata: { resourcetype: '<collection />' },
	});
}

function parseDestinationPath(destinationHeader: string, requestUrl: string): string | null {
	try {
		let destinationUrl = new URL(destinationHeader, requestUrl);
		if (destinationUrl.origin !== new URL(requestUrl).origin) {
			return null;
		}
		return decodeResourcePath(destinationUrl.pathname);
	} catch {
		return null;
	}
}

function isSameOrDescendantPath(resourcePath: string, destinationPath: string): boolean {
	if (destinationPath === resourcePath) {
		return true;
	}
	if (resourcePath === '') {
		return destinationPath !== '';
	}
	return destinationPath.startsWith(`${resourcePath}/`);
}

function createdResponse(
	resourcePath: string,
	isCollection: boolean,
	body: BodyInit | null = '',
	headers: HeadersInit = {},
): Response {
	let responseHeaders = new Headers(headers);
	responseHeaders.set('Location', getResourceHref(resourcePath, isCollection));
	return new Response(body, {
		status: 201,
		headers: responseHeaders,
	});
}

function renderDavProperty(propName: string, value: string): string {
	let content = RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value);
	return `<${propName}>${content}</${propName}>`;
}

function serializeNodeChildren(node: Node): string {
	let xml = '';
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		xml += child.toString();
	}
	return xml;
}

function getDeadPropertyKey(namespaceURI: string, localName: string): string {
	return `${DEAD_PROPERTY_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;
}

function getDeadProperty(
	metadata: Record<string, string> | undefined,
	namespaceURI: string,
	localName: string,
): DeadProperty | null {
	let value = metadata?.[getDeadPropertyKey(namespaceURI, localName)];
	if (value === undefined) {
		return null;
	}
	return JSON.parse(value) as DeadProperty;
}

function getDeadProperties(metadata: Record<string, string> | undefined): DeadProperty[] {
	if (metadata === undefined) {
		return [];
	}
	return Object.entries(metadata)
		.filter(([key]) => key.startsWith(DEAD_PROPERTY_PREFIX))
		.map(([, value]) => JSON.parse(value) as DeadProperty);
}

function renderPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration}>${property.valueXml}</${qualifiedName}>`;
}

function renderEmptyPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration} />`;
}

function getElementProperty(element: Element): DeadProperty | null {
	if (element.prefix && (element.namespaceURI === null || element.namespaceURI === '')) {
		return null;
	}
	return {
		namespaceURI: element.namespaceURI ?? '',
		localName: element.localName,
		prefix: element.prefix,
		valueXml: serializeNodeChildren(element),
	};
}

function parseXmlDocument(body: string): Document | null {
	let errors: string[] = [];
	let document = new DOMParser({
		errorHandler: {
			warning: () => {},
			error: (message) => errors.push(message),
			fatalError: (message) => errors.push(message),
		},
	}).parseFromString(body, 'application/xml');
	if (errors.length > 0) {
		return null;
	}
	return document;
}

function getChildElements(element: Element): Element[] {
	let children: Element[] = [];
	for (let child = element.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === child.ELEMENT_NODE) {
			children.push(child as Element);
		}
	}
	return children;
}

function parsePropfindRequest(body: string): PropfindRequest | null {
	if (body.trim() === '') {
		return { mode: 'allprop' };
	}
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propfind') {
		return null;
	}
	let propfindChildren = getChildElements(document.documentElement);
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'propname')) {
		return { mode: 'propname' };
	}
	let propElement = propfindChildren.find((child) => child.localName.toLowerCase() === 'prop');
	if (propElement !== undefined) {
		let properties = getChildElements(propElement).map(getElementProperty);
		if (properties.some((property) => property === null)) {
			return null;
		}
		return {
			mode: 'prop',
			properties: properties as DeadProperty[],
		};
	}
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'allprop')) {
		return { mode: 'allprop' };
	}
	return null;
}

function parseProppatchRequest(body: string): { operations: ProppatchOperation[] } | null {
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propertyupdate') {
		return null;
	}
	let operations: ProppatchOperation[] = [];
	for (const actionElement of getChildElements(document.documentElement)) {
		let action = actionElement.localName.toLowerCase();
		if (action !== 'set' && action !== 'remove') {
			continue;
		}
		let propElement = getChildElements(actionElement).find((child) => child.localName.toLowerCase() === 'prop');
		if (propElement === undefined) {
			continue;
		}
		for (const propertyElement of getChildElements(propElement)) {
			let property = getElementProperty(propertyElement);
			if (property === null) {
				return null;
			}
			operations.push({ action, property });
		}
	}
	return { operations };
}

function getSupportedLock(): string {
	return [
		'<lockentry><lockscope><exclusive /></lockscope><locktype><write /></locktype></lockentry>',
		'<lockentry><lockscope><shared /></lockscope><locktype><write /></locktype></lockentry>',
	].join('');
}

function determineLockDepth(
	resourceType: string | undefined,
	depthHeader: (typeof VALID_LOCK_DEPTHS)[number] | null,
): '0' | 'infinity' {
	if (resourceType === '<collection />') {
		return depthHeader ?? 'infinity';
	}
	return depthHeader === 'infinity' ? 'infinity' : '0';
}

function normalizeLockToken(lockToken: string): string {
	return lockToken
		.trim()
		.replace(/^<|>$/g, '')
		.replace(/^(?:urn:uuid:|opaquelocktoken:)/, '');
}

function normalizeLockDetails(lockDetails: Partial<LockDetails> & Pick<LockDetails, 'token'>): LockDetails | null {
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		expiresAt = Date.now() + DEFAULT_LOCK_TIMEOUT * 1000;
	}
	if (expiresAt <= Date.now()) {
		return null;
	}

	return {
		token: lockDetails.token,
		owner: lockDetails.owner,
		scope: lockDetails.scope === 'shared' ? 'shared' : 'exclusive',
		depth: lockDetails.depth === 'infinity' ? 'infinity' : '0',
		timeout: lockDetails.timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt,
		root: lockDetails.root ?? '/',
	};
}

function getLockDetails(customMetadata: Record<string, string> | undefined): LockDetails[] {
	let records = customMetadata?.[LOCK_RECORDS_METADATA_KEY];
	if (records !== undefined) {
		try {
			let parsed = JSON.parse(records);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((lockDetails) => {
					if (lockDetails && typeof lockDetails === 'object' && typeof lockDetails.token === 'string') {
						let normalized = normalizeLockDetails(lockDetails as Partial<LockDetails> & Pick<LockDetails, 'token'>);
						return normalized === null ? [] : [normalized];
					}
					return [];
				});
			}
		} catch {}
	}

	let token = customMetadata?.lock_token;
	if (token === undefined) {
		return [];
	}

	let normalized = normalizeLockDetails({
		token,
		owner: customMetadata?.lock_owner,
		scope: customMetadata?.lock_scope === 'shared' ? 'shared' : 'exclusive',
		depth: customMetadata?.lock_depth === 'infinity' ? 'infinity' : '0',
		timeout: customMetadata?.lock_timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Number(customMetadata?.lock_expires_at ?? 0),
		root: customMetadata?.lock_root ?? '/',
	});
	return normalized === null ? [] : [normalized];
}

function getLockDiscovery(lockDetails: LockDetails | LockDetails[]): string {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	return lockDetailList
		.map(
			(lockDetail) =>
				`<activelock><locktype><write /></locktype><lockscope><${lockDetail.scope} /></lockscope><depth>${lockDetail.depth}</depth>${lockDetail.owner ? `<owner>${escapeXml(lockDetail.owner)}</owner>` : ''}<timeout>${escapeXml(lockDetail.timeout)}</timeout><locktoken><href>urn:uuid:${escapeXml(lockDetail.token)}</href></locktoken><lockroot><href>${escapeXml(lockDetail.root)}</href></lockroot></activelock>`,
		)
		.join('');
}

function stripLockMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let metadata = customMetadata ? { ...customMetadata } : {};
	for (const key of LOCK_METADATA_KEYS) {
		delete metadata[key];
	}
	return metadata;
}

function withLockMetadata(
	customMetadata: Record<string, string> | undefined,
	lockDetails: LockDetails | LockDetails[],
): Record<string, string> {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	if (lockDetailList.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return {
		...stripLockMetadata(customMetadata),
		[LOCK_RECORDS_METADATA_KEY]: JSON.stringify(lockDetailList),
	};
}

function getPreservedCustomMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let lockDetails = getLockDetails(customMetadata);
	if (lockDetails.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return withLockMetadata(customMetadata, lockDetails);
}

function isProtectedProperty(propName: string | DeadProperty): boolean {
	let localPropName = typeof propName === 'string' ? (propName.split(':').pop() ?? propName) : propName.localName;
	return (
		LOCK_METADATA_KEYS.includes(localPropName) || localPropName === 'supportedlock' || localPropName === 'lockdiscovery'
	);
}

function isValidXmlTagName(propName: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9._:-]*$/.test(propName);
}

function parseTimeout(timeoutHeader: string | null): { timeout: string; expiresAt: number } {
	if (timeoutHeader === null) {
		return {
			timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
			expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
		};
	}

	for (const item of timeoutHeader.split(',').map((value) => value.trim())) {
		if (item.toLowerCase() === 'infinite') {
			return {
				timeout: 'Infinite',
				expiresAt: Date.now() + MAX_LOCK_TIMEOUT * 1000,
			};
		}

		let seconds = Number(item.match(/^Second-(\d+)$/i)?.[1] ?? NaN);
		if (Number.isFinite(seconds) && seconds > 0) {
			seconds = Math.min(seconds, MAX_LOCK_TIMEOUT);
			return {
				timeout: `Second-${seconds}`,
				expiresAt: Date.now() + seconds * 1000,
			};
		}
	}

	return {
		timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
	};
}

function getRequestLockTokens(request: Request): string[] {
	let lockTokens: string[] = [];
	let directLockToken = request.headers.get('Lock-Token');
	if (directLockToken) {
		lockTokens.push(normalizeLockToken(directLockToken));
	}

	let ifHeader = request.headers.get('If');
	if (ifHeader) {
		for (const match of ifHeader.matchAll(/<([^>]+)>/g)) {
			let token = normalizeLockToken(match[1]);
			if (token !== '') {
				lockTokens.push(token);
			}
		}
	}

	return [...new Set(lockTokens)];
}

function hasAlwaysFalseIfCondition(request: Request): boolean {
	let ifHeader = request.headers.get('If') ?? '';
	return ifHeader.includes('<DAV:no-lock>') && !ifHeader.includes('Not <DAV:no-lock>');
}

interface IfCondition {
	negate: boolean;
	// <urn:uuid:...> / <DAV:no-lock> state token (normalized)
	token?: string;
	// ["..."] / [W/"..."] entity tag, kept with quotes
	entityTag?: string;
}

interface IfList {
	// <http://host/path> resource tag; undefined for a no-tag list
	resourceTag?: string;
	conditions: IfCondition[];
}

// RFC 4918 §10.4 If header lexer: <...> (state token / resource tag),
// [...] (entity tag), "(" ")" list delimiters and the Not keyword.
function lexIfHeader(
	header: string,
): Array<{ kind: 'token' | 'entityTag' | 'listStart' | 'listEnd' | 'not'; value?: string }> | null {
	const tokens: Array<{ kind: 'token' | 'entityTag' | 'listStart' | 'listEnd' | 'not'; value?: string }> = [];
	let index = 0;
	while (index < header.length) {
		const ch = header[index];
		if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
			index++;
			continue;
		}
		if (ch === '(') {
			tokens.push({ kind: 'listStart' });
			index++;
			continue;
		}
		if (ch === ')') {
			tokens.push({ kind: 'listEnd' });
			index++;
			continue;
		}
		if (ch === '<') {
			const end = header.indexOf('>', index);
			if (end === -1) {
				return null;
			}
			tokens.push({ kind: 'token', value: header.slice(index + 1, end) });
			index = end + 1;
			continue;
		}
		if (ch === '[') {
			const end = header.indexOf(']', index);
			if (end === -1) {
				return null;
			}
			tokens.push({ kind: 'entityTag', value: header.slice(index + 1, end).trim() });
			index = end + 1;
			continue;
		}
		if (/^not[\s(]/i.test(header.slice(index))) {
			tokens.push({ kind: 'not' });
			index += 3;
			continue;
		}
		return null;
	}
	return tokens;
}

// Grammar: 1*No-tag-list | 1*Tagged-list; a bare state token outside a list
// (sent by some legacy clients) is tolerated as a single-condition list.
function parseIfHeader(header: string): IfList[] | null {
	const tokens = lexIfHeader(header);
	if (tokens === null) {
		return null;
	}

	const lists: IfList[] = [];
	let pendingResourceTag: string | undefined;
	let index = 0;
	while (index < tokens.length) {
		const tok = tokens[index];
		if (tok.kind === 'listStart') {
			const conditions: IfCondition[] = [];
			index++;
			let negate = false;
			while (index < tokens.length && tokens[index].kind !== 'listEnd') {
				const inner = tokens[index];
				if (inner.kind === 'not') {
					negate = true;
					index++;
					continue;
				}
				if (inner.kind === 'token') {
					conditions.push({ negate, token: normalizeLockToken(inner.value!) });
					negate = false;
					index++;
					continue;
				}
				if (inner.kind === 'entityTag') {
					conditions.push({ negate, entityTag: inner.value });
					negate = false;
					index++;
					continue;
				}
				return null;
			}
			if (tokens[index]?.kind !== 'listEnd' || conditions.length === 0) {
				return null;
			}
			index++;
			lists.push({ resourceTag: pendingResourceTag, conditions });
			pendingResourceTag = undefined;
			continue;
		}
		if (tok.kind === 'token') {
			// A "<...>" followed by a list is a resource tag; otherwise it is a
			// bare state token (legacy form).
			if (tokens[index + 1]?.kind === 'listStart') {
				pendingResourceTag = tok.value;
			} else {
				lists.push({ conditions: [{ negate: false, token: normalizeLockToken(tok.value!) }] });
			}
			index++;
			continue;
		}
		return null;
	}
	return lists;
}

function entityTagMatches(objectEtag: string | undefined, headerEntityTag: string): boolean {
	if (objectEtag === undefined) {
		return false;
	}
	const strip = (value: string) =>
		value
			.trim()
			.replace(/^W\//i, '')
			.replace(/^"(.*)"$/, '$1');
	return strip(objectEtag) === strip(headerEntityTag);
}

function resourcePathFromResourceTag(resourceTag: string): string | null {
	try {
		return decodeResourcePath(new URL(resourceTag).pathname);
	} catch {
		return null;
	}
}

// RFC 4918 §10.4: a list evaluates to true when every condition holds
// (token present on the resource, entity tag matching, each possibly
// negated); the whole header is true when at least one list is true.
async function evaluateIfHeader(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	requestObject: R2Object | null,
): Promise<boolean> {
	const header = request.headers.get('If');
	if (header === null || header.trim() === '') {
		return true;
	}
	const lists = parseIfHeader(header);
	if (lists === null) {
		// Unparseable header: do not reject on it (lock checks still apply).
		return true;
	}

	for (const list of lists) {
		let object = requestObject;
		if (list.resourceTag !== undefined) {
			const taggedPath = resourcePathFromResourceTag(list.resourceTag);
			if (taggedPath === null) {
				continue;
			}
			object = taggedPath === resourcePath ? requestObject : await bucket.head(taggedPath);
		}
		let listTrue = true;
		for (const condition of list.conditions) {
			let satisfied: boolean;
			if (condition.token !== undefined) {
				const activeTokens = getLockDetails(object?.customMetadata).map((detail) => detail.token);
				satisfied = activeTokens.includes(condition.token);
			} else {
				satisfied = object !== null && entityTagMatches(object.etag, condition.entityTag!);
			}
			if (condition.negate) {
				satisfied = !satisfied;
			}
			if (!satisfied) {
				listTrue = false;
				break;
			}
		}
		if (listTrue) {
			return true;
		}
	}
	return false;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	let mismatch = 0;
	for (let index = 0; index < left.byteLength; index++) {
		mismatch |= left[index] ^ right[index];
	}
	return mismatch === 0;
}

function extractLockOwner(body: string): string | undefined {
	let owner = body.match(/<owner(?:\s[^>]*)?>([\s\S]*?)<\/owner>/i)?.[1];
	if (owner === undefined) {
		return undefined;
	}

	owner = owner.trim();
	return owner === '' ? undefined : owner;
}

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: new Date().toUTCString(),
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: '0',
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: new Date().toUTCString(),
			resourcetype: '<collection />',
			supportedlock: getSupportedLock(),
			lockdiscovery: '',
		};
	}

	let isCollection = object.customMetadata?.resourcetype === '<collection />';
	let lockDetails = getLockDetails(object.customMetadata);
	return {
		creationdate: object.uploaded.toUTCString(),
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.customMetadata?.resourcetype ?? '',
		supportedlock: getSupportedLock(),
		lockdiscovery:
			lockDetails.length === 0
				? ''
				: getLockDiscovery(
						lockDetails.map((lockDetail) => ({
							...lockDetail,
							root: getResourceHref(object.key, isCollection),
						})),
					),
	};
}

function getLivePropertyValue(object: R2Object | null, property: DeadProperty): string | undefined {
	if (property.namespaceURI !== DAV_NAMESPACE) {
		return undefined;
	}
	return fromR2Object(object)[property.localName as keyof DavProperties];
}

function renderPropstat(status: string, properties: string[]): string {
	if (properties.length === 0) {
		return '';
	}
	return `
		<propstat>
			<prop>
			${properties.join('\n				')}
			</prop>
			<status>${status}</status>
		</propstat>`;
}

function make_resource_path(request: Request): string {
	return decodeResourcePath(new URL(request.url).pathname);
}

async function assertLockPermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	options: { ignoreSharedLocksOnTarget?: boolean } = {},
): Promise<Response | null> {
	if (hasAlwaysFalseIfCondition(request)) {
		return new Response('Precondition Failed', { status: 412 });
	}
	let lockTokens = getRequestLockTokens(request);
	let candidates: string[] = [];

	for (let current = resourcePath; current !== ''; current = current.split('/').slice(0, -1).join('/')) {
		candidates.push(current);
	}

	for (const candidate of candidates) {
		let object = await bucket.head(candidate);
		let lockDetails = getLockDetails(object?.customMetadata).filter(
			(lockDetail) =>
				(candidate === resourcePath || lockDetail.depth === 'infinity') &&
				!(options.ignoreSharedLocksOnTarget && candidate === resourcePath && lockDetail.scope === 'shared'),
		);
		if (lockDetails.length === 0) {
			continue;
		}

		if (!lockDetails.some((lockDetail) => lockTokens.includes(lockDetail.token))) {
			return new Response('Locked', { status: 423 });
		}
	}

	return null;
}

async function assertRecursiveDeletePermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<Response | null> {
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockTokens = getRequestLockTokens(request);
	let prefix = resourcePath === '' ? '' : resourcePath + '/';
	for await (let descendant of listAll(bucket, prefix, true)) {
		let lockDetails = getLockDetails(descendant.customMetadata);
		if (lockDetails.length > 0 && !lockDetails.some((lockDetail) => lockTokens.includes(lockDetail.token))) {
			return new Response('Locked', { status: 423 });
		}
	}

	return null;
}

async function findMatchingLock(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<{ resource: R2Object; lockDetails: LockDetails } | null> {
	let lockTokens = getRequestLockTokens(request);
	for (let current = resourcePath; ; current = current.split('/').slice(0, -1).join('/')) {
		let resource = await bucket.head(current);
		let lockDetails = getLockDetails(resource?.customMetadata).find(
			(lockDetail) =>
				lockTokens.includes(lockDetail.token) && (current === resourcePath || lockDetail.depth === 'infinity'),
		);
		if (resource !== null && lockDetails !== undefined) {
			return { resource, lockDetails };
		}
		if (current === '') {
			break;
		}
	}
	return null;
}

async function handle_head(request: Request, bucket: R2Bucket): Promise<Response> {
	let response = await handle_get(request, bucket);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function handle_get(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (request.url.endsWith('/')) {
		if (resource_path !== '') {
			// A collection may also exist implicitly, as a key prefix with no marker
			// object behind it. hasCollectionResource() covers both cases.
			if (!(await hasCollectionResource(bucket, resource_path))) {
				return new Response('Not Found', { status: 404 });
			}
		}

		let page = '',
			prefix = resource_path;
		if (resource_path !== '') {
			page += `<a href="../">..</a><br>`;
			prefix = `${resource_path}/`;
		}

		for await (const member of listMembers(bucket, prefix)) {
			let href: string;
			let name: string;
			if (member.kind === 'collection') {
				href = getResourceHref(member.key, true);
				name = member.key.slice(prefix.length);
			} else {
				href = getResourceHref(member.object.key, false);
				name = member.object.httpMetadata?.contentDisposition ?? member.object.key.slice(prefix.length);
			}
			page += `<a href="${escapeXml(href)}">${escapeXml(name)}</a><br>`;
		}
		// 定义模板
		var pageSource = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>R2Storage</title><style>*{box-sizing:border-box;}body{padding:10px;font-family:'Segoe UI','Circular','Roboto','Lato','Helvetica Neue','Arial Rounded MT Bold','sans-serif';}a{display:inline-block;width:100%;color:#000;text-decoration:none;padding:5px 10px;cursor:pointer;border-radius:5px;}a:hover{background-color:#60C590;color:white;}a[href="../"]{background-color:#cbd5e1;}</style></head><body><h1>R2 Storage</h1><div>${page}</div></body></html>`;

		return new Response(pageSource, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	} else {
		let object = await bucket.get(resource_path, {
			onlyIf: request.headers,
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		};

		if (object === null) {
			return new Response('Not Found', { status: 404 });
		} else if (!isR2ObjectBody(object)) {
			return new Response('Precondition Failed', { status: 412 });
		} else {
			const { rangeOffset, rangeEnd } = calcContentRange(object);
			const contentLength = rangeEnd - rangeOffset + 1;
			const rangeRequested = request.headers.has('Range') && object.range !== undefined;
			return new Response(object.body, {
				status: rangeRequested ? 206 : 200,
				headers: {
					'Accept-Ranges': 'bytes',
					// httpEtag is the object's etag in quotes, ready for a header.
					// Clients rely on it for If-Match optimistic concurrency on PUT.
					'ETag': object.httpEtag,
					'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
					'Content-Length': contentLength.toString(),
					...(rangeRequested ? { 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` } : {}),
					...(object.httpMetadata?.contentDisposition
						? {
								'Content-Disposition': object.httpMetadata.contentDisposition,
							}
						: {}),
					...(object.httpMetadata?.contentEncoding
						? {
								'Content-Encoding': object.httpMetadata.contentEncoding,
							}
						: {}),
					...(object.httpMetadata?.contentLanguage
						? {
								'Content-Language': object.httpMetadata.contentLanguage,
							}
						: {}),
					...(object.httpMetadata?.cacheControl
						? {
								'Cache-Control': object.httpMetadata.cacheControl,
							}
						: {}),
					...(object.httpMetadata?.cacheExpiry
						? {
								'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
							}
						: {}),
				},
			});
		}
	}
}

function calcContentRange(object: R2ObjectBody) {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			// Case 3: {suffix: number}
			rangeOffset = object.size - object.range.suffix;
		} else {
			// Case 1: {offset: number, length?: number}
			// Case 2: {offset?: number, length: number}
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

async function handle_put(request: Request, bucket: R2Bucket): Promise<Response> {
	if (request.url.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}
	let existing = await bucket.head(resource_path);

	// RFC 4918 §10.4: evaluate the WebDAV If header (lock tokens + entity
	// tags). R2 only understands HTTP conditional headers (If-Match etc.),
	// so the If header must be enforced here before writing.
	if (!(await evaluateIfHeader(request, bucket, resource_path, existing))) {
		return new Response('Precondition Failed', { status: 412 });
	}

	// Check if the parent directory exists
	let dirpath = getParentPath(resource_path);
	if (!(await hasCollectionResource(bucket, dirpath))) {
		return new Response('Conflict', { status: 409 });
	}

	let body = await request.arrayBuffer();
	// R2 returns null (and stores nothing) when a conditional request header
	// such as If-Match / If-None-Match fails its precondition.
	let written = await bucket.put(resource_path, body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
		customMetadata: getPreservedCustomMetadata(existing?.customMetadata),
	});
	if (written === null) {
		return new Response('Precondition Failed', { status: 412 });
	}
	return new Response(existing === null ? '' : null, {
		status: existing === null ? 201 : 204,
		headers: { 'ETag': written.httpEtag },
	});
}

async function handle_delete(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let lockResponse = await assertRecursiveDeletePermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	if (resource_path === '') {
		let r2_objects,
			cursor: string | undefined = undefined;
		do {
			r2_objects = await bucket.list({ cursor: cursor });
			let keys = r2_objects.objects.map((object) => object.key);
			if (keys.length > 0) {
				await bucket.delete(keys);
			}

			if (r2_objects.truncated) {
				cursor = r2_objects.cursor;
			}
		} while (r2_objects.truncated);

		return new Response(null, { status: 204 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		// No marker object, but the key may still exist implicitly as a prefix of
		// other objects. Such a collection must be deletable too, otherwise it
		// would be visible in PROPFIND yet impossible to remove.
		if (!(await hasCollectionResource(bucket, resource_path))) {
			return new Response('Not Found', { status: 404 });
		}
	} else if (resource.customMetadata?.resourcetype !== '<collection />') {
		await bucket.delete(resource_path);
		return new Response(null, { status: 204 });
	}

	// Collection: remove every descendant, then the marker object if there is one.
	let r2_objects,
		cursor: string | undefined = undefined;
	do {
		r2_objects = await bucket.list({
			prefix: resource_path + '/',
			cursor: cursor,
		});
		let keys = r2_objects.objects.map((object) => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);

	if (resource !== null) {
		await bucket.delete(resource_path);
	}
	return new Response(null, { status: 204 });
}

async function handle_mkcol(request: Request, bucket: R2Bucket): Promise<Response> {
	if ((await request.clone().arrayBuffer()).byteLength > 0) {
		return new Response('Unsupported Media Type', { status: 415 });
	}

	let resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the resource already exists
	let resource = await bucket.head(resource_path);
	if (resource !== null) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parent_dir = getParentPath(resource_path);
	if (!(await hasCollectionResource(bucket, parent_dir))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resource_path, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
}

/**
 * @param object the R2 object backing the resource, or null for the root
 *   collection and for synthetic (implicit) collections.
 * @param syntheticCollectionKey key of an implicit collection, i.e. a
 *   directory that exists only as a key prefix and therefore has no R2 object
 *   behind it. Properties are then derived from a null object, exactly like the
 *   root collection, and only the href differs.
 */
function generate_propfind_response(
	object: R2Object | null,
	propfindRequest: PropfindRequest,
	syntheticCollectionKey: string | null = null,
): string {
	let isCollection =
		syntheticCollectionKey !== null || object?.customMetadata?.resourcetype === '<collection />';
	let href =
		object !== null
			? getResourceHref(object.key, isCollection)
			: syntheticCollectionKey !== null
				? getResourceHref(syntheticCollectionKey, true)
				: '/';
	let deadProperties = getDeadProperties(object?.customMetadata);
	let liveProperties = Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
		value === undefined ? [] : [renderDavProperty(key, value)],
	);

	let okProperties: string[] = [];
	let missingProperties: string[] = [];

	switch (propfindRequest.mode) {
		case 'allprop': {
			okProperties = [...liveProperties, ...deadProperties.map(renderPropertyElement)];
			break;
		}
		case 'propname': {
			okProperties = [
				...Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
					value === undefined ? [] : [renderDavProperty(key, '')],
				),
				...deadProperties.map((property) => renderEmptyPropertyElement({ ...property, valueXml: '' })),
			];
			break;
		}
		case 'prop': {
			for (const property of propfindRequest.properties) {
				let liveValue = getLivePropertyValue(object, property);
				if (liveValue !== undefined) {
					okProperties.push(renderDavProperty(property.localName, liveValue));
					continue;
				}
				let deadProperty = getDeadProperty(object?.customMetadata, property.namespaceURI, property.localName);
				if (deadProperty !== null) {
					okProperties.push(renderPropertyElement(deadProperty));
				} else {
					missingProperties.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
				}
			}
			break;
		}
	}

	return `
	<response>
		<href>${escapeXml(href)}</href>${renderPropstat('HTTP/1.1 200 OK', okProperties)}${renderPropstat('HTTP/1.1 404 Not Found', missingProperties)}
	</response>`;
}

async function handle_propfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let propfindRequest = parsePropfindRequest(await request.text());
	if (propfindRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}

	let is_collection: boolean;
	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	if (resource_path === '') {
		page += generate_propfind_response(null, propfindRequest);
		is_collection = true;
	} else {
		let object = await bucket.head(resource_path);
		if (object === null) {
			// No marker object, but the key may still exist as a prefix of other
			// objects (an implicit collection written straight into R2).
			if (!(await hasCollectionResource(bucket, resource_path))) {
				return new Response('Not Found', { status: 404 });
			}
			is_collection = true;
			page += generate_propfind_response(null, propfindRequest, resource_path);
		} else {
			is_collection = object.customMetadata?.resourcetype === '<collection />';
			page += generate_propfind_response(object, propfindRequest);
		}
	}

	if (is_collection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let member of listMembers(bucket, prefix)) {
						page +=
							member.kind === 'object'
								? generate_propfind_response(member.object, propfindRequest)
								: generate_propfind_response(null, propfindRequest, member.key);
					}
				}
				break;
			case 'infinity':
				{
					// Intentionally still listAll(): a depth-infinity response is a flat
					// list, and expanding implicit collections here would require every
					// intermediate level to be synthesised as well. listAll() only ever
					// yields real R2 objects, which is what the recursive LOCK / COPY /
					// MOVE paths rely on too.
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let object of listAll(bucket, prefix, true)) {
						page += generate_propfind_response(object, propfindRequest);
					}
				}
				break;
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handle_proppatch(request: Request, bucket: R2Bucket): Promise<Response> {
	const resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// 检查资源是否存在
	let object = await bucket.head(resource_path);
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	const body = await request.text();
	let parsedRequest = parseProppatchRequest(body);
	if (parsedRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}
	const { operations } = parsedRequest;

	// 复制原有的自定义元数据
	const customMetadata = getPreservedCustomMetadata(object.customMetadata);
	const successfulSetProperties: DeadProperty[] = [];
	const failedSetProperties: DeadProperty[] = [];
	const successfulRemoveProperties: DeadProperty[] = [];
	const failedRemoveProperties: DeadProperty[] = [];

	// 更新元数据
	for (const operation of operations) {
		if (isProtectedProperty(operation.property)) {
			if (operation.action === 'set') {
				failedSetProperties.push(operation.property);
			} else {
				failedRemoveProperties.push(operation.property);
			}
			continue;
		}
		if (operation.action === 'set') {
			customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)] =
				JSON.stringify(operation.property);
			successfulSetProperties.push(operation.property);
		} else {
			delete customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)];
			successfulRemoveProperties.push(operation.property);
		}
	}

	const hasFailures = failedSetProperties.length > 0 || failedRemoveProperties.length > 0;
	if (!hasFailures) {
		// 更新对象的元数据
		const src = await bucket.get(object.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}

		await bucket.put(object.key, src.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: customMetadata,
		});
	}

	// 构造响应
	let propstats = new Map<string, string[]>();
	const appendPropstat = (property: DeadProperty, status: string) => {
		let props = propstats.get(status) ?? [];
		props.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
		propstats.set(status, props);
	};
	const successStatus = hasFailures ? 'HTTP/1.1 424 Failed Dependency' : 'HTTP/1.1 200 OK';

	for (const property of successfulSetProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of successfulRemoveProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of failedSetProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	for (const property of failedRemoveProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	let responseXML = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n\t<response>\n\t\t<href>${escapeXml(getResourceHref(object.key, object.customMetadata?.resourcetype === '<collection />'))}</href>`;
	for (const [status, propNames] of propstats) {
		responseXML += `\n\t\t<propstat>\n\t\t\t<prop>\n${propNames.map((propName) => `\t\t\t\t${propName}`).join('\n')}\n\t\t\t</prop>\n\t\t\t<status>${status}</status>\n\t\t</propstat>`;
	}
	responseXML += '\n\t</response>\n</multistatus>';

	return new Response(responseXML, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handle_copy(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let dont_overwrite = request.headers.get('Overwrite') === 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destination_header, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resource_path, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, destination);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the parent directory exists
	let destination_parent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (dont_overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	let is_implicit_collection = false;
	if (resource === null) {
		// A collection may exist only as a key prefix, with no marker object.
		if (!(await hasCollectionResource(bucket, resource_path))) {
			return new Response('Not Found', { status: 404 });
		}
		is_implicit_collection = true;
	}

	let is_dir = is_implicit_collection || resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const copy = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: stripLockMetadata(object.customMetadata),
						});
					}
				};
				// An implicit collection has no marker object to copy, so write an
				// explicit one at the destination: a COPY must preserve the resource
				// type (RFC 4918 §15.9 COPY/MOVE behavior).
				let promise_array: Promise<void>[] =
					resource !== null ? [copy(resource)] : [writeCollectionMarker(bucket, destination)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(copy(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			case '0': {
				if (resource === null) {
					await writeCollectionMarker(bucket, destination);
				} else {
					let object = await bucket.get(resource.key);
					if (object === null) {
						return new Response('Not Found', { status: 404 });
					}
					await bucket.put(destination, object.body, {
						httpMetadata: object.httpMetadata,
						customMetadata: stripLockMetadata(object.customMetadata),
					});
				}
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		if (resource === null) {
			// Unreachable: a missing marker object means an implicit collection, so
			// is_dir would be true. Kept so the type checker can narrow `resource`.
			return new Response('Not Found', { status: 404 });
		}
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: stripLockMetadata(src.customMetadata),
		});
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handle_move(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let overwrite = (request.headers.get('Overwrite') ?? 'T') !== 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destination_header, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resource_path, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let sourceLockResponse = await assertLockPermission(request, bucket, resource_path);
	if (sourceLockResponse !== null) {
		return sourceLockResponse;
	}
	let destinationLockResponse = await assertLockPermission(request, bucket, destination);
	if (destinationLockResponse !== null) {
		return destinationLockResponse;
	}

	// Check if the parent directory exists
	let destination_parent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (!overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	let is_implicit_collection = false;
	if (resource === null) {
		// A collection may exist only as a key prefix, with no marker object.
		if (!(await hasCollectionResource(bucket, resource_path))) {
			return new Response('Not Found', { status: 404 });
		}
		is_implicit_collection = true;
	} else if (resource.key === destination) {
		return new Response('Bad Request', { status: 400 });
	}

	if (destination_exists) {
		// Delete the destination first
		let deleteHeaders = new Headers();
		for (const headerName of INTERNAL_DELETE_FORWARD_HEADERS) {
			let headerValue = request.headers.get(headerName);
			if (headerValue !== null) {
				deleteHeaders.set(headerName, headerValue);
			}
		}
		let deleteResponse = await handle_delete(
			new Request(new URL(destination_header), {
				method: 'DELETE',
				headers: deleteHeaders,
			}),
			bucket,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	let is_dir = is_implicit_collection || resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const move = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: getPreservedCustomMetadata(object.customMetadata),
						});
						await bucket.delete(object.key);
					}
				};
				// An implicit collection has no marker object to move, so write an
				// explicit one at the destination: a MOVE must preserve the resource
				// type (RFC 4918 §15.9 COPY/MOVE behavior).
				let promise_array: Promise<void>[] =
					resource !== null ? [move(resource)] : [writeCollectionMarker(bucket, destination)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(move(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		if (resource === null) {
			// Unreachable: a missing marker object means an implicit collection, so
			// is_dir would be true. Kept so the type checker can narrow `resource`.
			return new Response('Not Found', { status: 404 });
		}
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: getPreservedCustomMetadata(src.customMetadata),
		});
		await bucket.delete(resource.key);
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handle_lock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let depthHeader = request.headers.get('Depth');
	if (depthHeader !== null && !VALID_LOCK_DEPTHS.includes(depthHeader as (typeof VALID_LOCK_DEPTHS)[number])) {
		return new Response('Bad Request', { status: 400 });
	}
	let { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
	let body = await request.text();
	// Per WebDAV, an empty LOCK request body indicates a lock refresh operation.
	let requestedScope: LockDetails['scope'] = /<shared\b/i.test(body) ? 'shared' : 'exclusive';
	let requestLockTokens = getRequestLockTokens(request);
	if (body !== '' && !/<write\b/i.test(body)) {
		return new Response('Bad Request', { status: 400 });
	}
	let owner = extractLockOwner(body);
	let lockResponse = await assertLockPermission(request, bucket, resource_path, {
		ignoreSharedLocksOnTarget: body !== '' && requestedScope === 'shared',
	});
	if (lockResponse !== null) {
		return lockResponse;
	}

	let refreshTarget = body === '' ? await findMatchingLock(request, bucket, resource_path) : null;
	let resource = refreshTarget?.resource ?? (await bucket.head(resource_path));
	let currentLocks = getLockDetails(resource?.customMetadata);
	let existingLock = refreshTarget?.lockDetails;
	if (
		refreshTarget === null &&
		body === '' &&
		resource !== null &&
		currentLocks.length > 0 &&
		!currentLocks.some((currentLock) => requestLockTokens.includes(currentLock.token))
	) {
		return new Response('Locked', { status: 423 });
	}
	if (resource === null) {
		if (body === '') {
			return new Response('Bad Request', { status: 400 });
		}
		if (!(await hasCollectionResource(bucket, getParentPath(resource_path)))) {
			return new Response('Conflict', { status: 409 });
		}
		if (request.url.endsWith('/')) {
			return new Response('Conflict', { status: 409 });
		}

		await bucket.put(resource_path, new Uint8Array(), {
			customMetadata: {},
		});
		resource = await bucket.head(resource_path);
		currentLocks = [];
	}

	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (existingLock === undefined) {
		if (requestedScope === 'exclusive' && currentLocks.length > 0) {
			return new Response('Locked', { status: 423 });
		}
		if (requestedScope === 'shared' && currentLocks.some((lockDetail) => lockDetail.scope === 'exclusive')) {
			return new Response('Locked', { status: 423 });
		}
	}
	let depth: (typeof VALID_LOCK_DEPTHS)[number];
	if (existingLock !== undefined && depthHeader === null && body === '') {
		// Refreshing an existing lock without an explicit Depth header:
		// preserve the original lock depth instead of broadening it.
		depth = existingLock.depth;
	} else {
		depth = determineLockDepth(
			resource.customMetadata?.resourcetype,
			depthHeader as (typeof VALID_LOCK_DEPTHS)[number] | null,
		);
	}

	let lockDetails: LockDetails = {
		token: existingLock?.token ?? crypto.randomUUID(),
		owner: owner ?? existingLock?.owner,
		scope: existingLock?.scope ?? requestedScope,
		depth,
		timeout,
		expiresAt,
		root: getResourceHref(resource.key, resource.customMetadata?.resourcetype === '<collection />'),
	};
	let updatedLocks =
		existingLock === undefined
			? [...currentLocks, lockDetails]
			: currentLocks.map((currentLock) => (currentLock.token === existingLock.token ? lockDetails : currentLock));

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: withLockMetadata(resource.customMetadata, updatedLocks),
	});

	return new Response(
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(updatedLocks)}</lockdiscovery></prop>`,
		{
			status: existingLock ? 200 : 201,
			headers: {
				'Content-Type': 'application/xml; charset=utf-8',
				'Lock-Token': `<urn:uuid:${lockDetails.token}>`,
				...(existingLock
					? {}
					: {
							Location: getResourceHref(resource.key, resource.customMetadata?.resourcetype === '<collection />'),
						}),
			},
		},
	);
}

async function handle_unlock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockDetails = getLockDetails(resource.customMetadata);
	let normalizedToken = normalizeLockToken(lockToken);
	if (!lockDetails.some((lockDetail) => lockDetail.token === normalizedToken)) {
		return new Response('Conflict', { status: 409 });
	}

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: withLockMetadata(
			resource.customMetadata,
			lockDetails.filter((lockDetail) => lockDetail.token !== normalizedToken),
		),
	});

	return new Response(null, { status: 204 });
}

const DAV_CLASS = '1, 2';
const SUPPORT_METHODS = [
	'OPTIONS',
	'PROPFIND',
	'PROPPATCH',
	'MKCOL',
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'COPY',
	'MOVE',
	'LOCK',
	'UNLOCK',
];

async function dispatch_handler(request: Request, bucket: R2Bucket): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return new Response(null, {
				status: 200,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
		case 'HEAD': {
			return await handle_head(request, bucket);
		}
		case 'GET': {
			return await handle_get(request, bucket);
		}
		case 'PUT': {
			return await handle_put(request, bucket);
		}
		case 'DELETE': {
			return await handle_delete(request, bucket);
		}
		case 'MKCOL': {
			return await handle_mkcol(request, bucket);
		}
		case 'PROPFIND': {
			return await handle_propfind(request, bucket);
		}
		case 'PROPPATCH': {
			return await handle_proppatch(request, bucket);
		}
		case 'COPY': {
			return await handle_copy(request, bucket);
		}
		case 'MOVE': {
			return await handle_move(request, bucket);
		}
		case 'LOCK': {
			return await handle_lock(request, bucket);
		}
		case 'UNLOCK': {
			return await handle_unlock(request, bucket);
		}
		default: {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
	}
}

function is_authorized(authorization_header: string, username: string, password: string): boolean {
	const encoder = new TextEncoder();

	const header = encoder.encode(authorization_header);
	const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

	return timingSafeEqual(header, expected);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;

		if (
			request.method !== 'OPTIONS' &&
			!is_authorized(request.headers.get('Authorization') ?? '', env.USERNAME, env.PASSWORD)
		) {
			return new Response('Unauthorized', {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				},
			});
		}

		let response: Response = await dispatch_handler(request, bucket);

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set(
			'Access-Control-Allow-Headers',
			[
				'authorization',
				'content-type',
				'depth',
				'overwrite',
				'destination',
				'range',
				'if',
				'lock-token',
				'timeout',
			].join(', '),
		);
		response.headers.set(
			'Access-Control-Expose-Headers',
			[
				'content-type',
				'content-length',
				'dav',
				'etag',
				'last-modified',
				'location',
				'date',
				'content-range',
				'lock-token',
			].join(', '),
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return response;
	},
};
