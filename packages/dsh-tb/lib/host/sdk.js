import { homedir } from "node:os";
import { join, resolve } from "node:path";
//#region src/host/sdk.ts
/**
* Self-contained replacements for the three @deepseek-ai runtime imports the
* host half used to take from npm-mirror SDK packages (dsh-home-paths,
* dsh-llm/brand, dsh-tools' defineTool).
*
* Why: a published copy must never resolve `@deepseek-ai/dsh-tools` from the
* profile's node_modules — an npm-mirror dsh-tools there shadows the
* CLI-internal build for the WHOLE base layer, and the agent loop's private
* scheduler symbol then misses (`Cannot read properties of undefined
* (reading 'prepare')` on every tool call). Everything here is a pure,
* structure-compatible reimplementation of the exact behavior we relied on:
*
* - `dshHomePath` mirrors `join(resolve(env.DSH_HOME ?? ~/.dsh), ...segments)`;
* - `MessageId` is the identity brand the SDK applies at runtime;
* - `defineTool` compiles our author-facing parameter specs into the same
*   raw JSON-Schema subset the registry expects (object/properties/required/
*   additionalProperties/scalars; the `json` node compiles to an
*   annotation-only schema) and pre-validates model arguments the same way.
*
* @module dsh-taskboard/host/sdk
*/
/** The ledger file's parent: the DSH user home (DSH_HOME overrides). */
function dshHomePath(...segments) {
	const override = process.env.DSH_HOME;
	return join(resolve(override !== void 0 && override.length > 0 ? override : join(homedir(), ".dsh")), ...segments);
}
/** Identity brand — runtime no-op, exactly like the SDK's MessageId(). */
function MessageId(id) {
	return id;
}
/** Compile one value spec to the raw subset (json → annotation-only). */
function compileValue(spec) {
	const node = {};
	const description = spec.description;
	if (typeof description === "string" && description.length > 0) node.description = description;
	const type = spec.type;
	if (type === void 0 || type === "json") return node;
	if (type === "object") {
		const objectSpec = spec;
		node.type = "object";
		node.additionalProperties = objectSpec.additionalProperties;
		if (objectSpec.properties !== void 0) node.properties = compilePropertyMap(objectSpec.properties).properties;
		return node;
	}
	if (type === "array") {
		node.type = "array";
		const items = spec.items;
		if (items !== void 0) node.items = compileValue(items);
		return node;
	}
	node.type = type;
	const enumValues = spec.enum;
	if (enumValues !== void 0) node.enum = [...enumValues];
	const constValue = spec.const;
	if (constValue !== void 0) node.const = constValue;
	return node;
}
/** Compile a property map: properties + collected required list. */
function compilePropertyMap(spec) {
	const properties = {};
	const required = [];
	for (const [name, entry] of Object.entries(spec)) {
		const { required: isRequired, ...valueSpec } = entry;
		properties[name] = compileValue(valueSpec);
		if (isRequired === true) required.push(name);
	}
	return required.length > 0 ? {
		properties,
		required
	} : { properties };
}
/** Does a JS value match a raw-subset scalar type? */
function matchesScalarType(value, type) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return typeof value === "number";
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		default: return true;
	}
}
/** Validate a value against the compiled subset; returns path-qualified violations. */
function validateValue(schema, value, path) {
	if (typeof schema.type !== "string" || schema.type.length === 0) return [];
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path} must be an object`];
		const violations = [];
		const present = value;
		for (const key of schema.required ?? []) if (!(key in present)) violations.push(`${path}.${key} is required`);
		if (schema.additionalProperties === false) {
			const known = new Set(Object.keys(schema.properties ?? {}));
			for (const key of Object.keys(present)) if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`);
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in present) violations.push(...validateValue(child, present[key], `${path}.${key}`));
		return violations;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) return [`${path} must be an array`];
		const violations = [];
		const items = schema.items;
		if (items !== void 0) value.forEach((item, index) => {
			violations.push(...validateValue(items, item, `${path}[${index}]`));
		});
		return violations;
	}
	return matchesScalarType(value, schema.type) ? [] : [`${path} must be ${schema.type}`];
}
/**
* Define a first-party tool: compile the parameter spec, pre-validate
* arguments (message format matches the SDK's ToolArgsError), and pass
* through the execution.
*/
function defineTool(options) {
	const compiled = compilePropertyMap(options.parameters);
	const parameters = {
		type: "object",
		properties: compiled.properties
	};
	if (compiled.required !== void 0) parameters.required = compiled.required;
	const userExecute = options.execute;
	return {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: {},
			render(args, value) {
				return options.output.render(args, value);
			}
		},
		async execute(args, exec) {
			const violations = validateValue(parameters, args, "arguments");
			if (violations.length > 0) throw new Error(`Error: invalid arguments: ${violations.join("; ")}`);
			return userExecute(args, exec);
		}
	};
}
//#endregion
export { MessageId, defineTool, dshHomePath };

//# sourceMappingURL=sdk.js.map