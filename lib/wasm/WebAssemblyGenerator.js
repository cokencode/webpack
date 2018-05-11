/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

const Generator = require("../Generator");
const Template = require("../Template");
const WebAssemblyUtils = require("./WebAssemblyUtils");
const WebAssemblyImportDependency = require("../dependencies/WebAssemblyImportDependency");
const { RawSource } = require("webpack-sources");

const { edit, add } = require("@webassemblyjs/wasm-edit");
const { decode } = require("@webassemblyjs/wasm-parser");
const t = require("@webassemblyjs/ast");

/** @typedef {import("../Module")} Module */
/** @typedef {import("./WebAssemblyUtils").UsedWasmDependency} UsedWasmDependency */

function compose(...fns) {
	return fns.reduce((prevFn, nextFn) => {
		return value => nextFn(prevFn(value));
	}, value => value);
}

// Utility functions
const isGlobalImport = moduleImport => moduleImport.descr.type === "GlobalType";
const isFuncImport = moduleImport =>
	moduleImport.descr.type === "FuncImportDescr";

// TODO replace with @callback
/**
 * @typedef {(ArrayBuffer) => ArrayBuffer} ArrayBufferTransform
 */

/**
 * Removes the start instruction
 *
 * @param {Object} state - unused state
 * @returns {ArrayBufferTransform} transform
 */
const removeStartFunc = state => bin => {
	return edit(bin, {
		Start(path) {
			path.remove();
		}
	});
};

/**
 * Retrieve the start function
 *
 * @param {Object} ast - Module's AST
 * @returns {t.Identifier | undefined} - node if any
 */
function getStartFuncIndex(ast) {
	let startAtFuncIndex;

	t.traverse(ast, {
		Start({ node }) {
			startAtFuncIndex = node.index;
		}
	});

	return startAtFuncIndex;
}

/**
 * Get imported globals
 *
 * @param {Object} ast - Module's AST
 * @returns {Array<t.ModuleImport>} - nodes
 */
function getImportedGlobals(ast) {
	const importedGlobals = [];

	t.traverse(ast, {
		ModuleImport({ node }) {
			if (isGlobalImport(node) === true) {
				importedGlobals.push(node);
			}
		}
	});

	return importedGlobals;
}

function getCountImportedFunc(ast) {
	let count = 0;

	t.traverse(ast, {
		ModuleImport({ node }) {
			if (isFuncImport(node) === true) {
				count++;
			}
		}
	});

	return count;
}

/**
 * Get next type index
 *
 * @param {Object} ast - Module's AST
 * @returns {t.IndexLiteral} - index
 */
function getNextTypeIndex(ast) {
	const typeSectionMetadata = t.getSectionMetadata(ast, "type");

	if (typeof typeSectionMetadata === "undefined") {
		return t.indexLiteral(0);
	}

	return t.indexLiteral(typeSectionMetadata.vectorOfSize.value);
}

/**
 * Get next func index
 *
 * The Func section metadata provide informations for implemented funcs
 * in order to have the correct index we shift the index by number of external
 * functions.
 *
 * @param {Object} ast - Module's AST
 * @param {Number} countImportedFunc - number of imported funcs
 * @returns {t.IndexLiteral} - index
 */
function getNextFuncIndex(ast, countImportedFunc) {
	const funcSectionMetadata = t.getSectionMetadata(ast, "func");

	if (typeof funcSectionMetadata === "undefined") {
		return t.indexLiteral(0 + countImportedFunc);
	}

	const vectorOfSize = funcSectionMetadata.vectorOfSize.value;

	return t.indexLiteral(vectorOfSize + countImportedFunc);
}

/**
 * Rewrite the import globals:
 * - removes the ModuleImport instruction
 * - injects at the same offset a mutable global of the same time
 *
 * Since the imported globals are before the other global declarations, our
 * indices will be preserved.
 *
 * Note that globals will become mutable.
 *
 * @param {Object} state - unused state
 * @returns {ArrayBufferTransform} transform
 */
const rewriteImportedGlobals = state => bin => {
	const newGlobals = [];

	bin = edit(bin, {
		ModuleImport(path) {
			if (isGlobalImport(path.node) === true) {
				const globalType = path.node.descr;

				globalType.mutability = "var";

				newGlobals.push(
					t.global(globalType, [
						t.objectInstruction("const", "i32", [t.numberLiteral(0)])
					])
				);

				path.remove();
			}
		}
	});

	// Add global declaration instructions
	return add(bin, newGlobals);
};

/**
 * Rewrite the export names
 * @param {Object} state state
 * @param {Module} state.module current module
 * @returns {ArrayBufferTransform} transform
 */
const rewriteExportNames = state => bin => {
	return edit(bin, {
		ModuleExport(path) {
			const usedName = state.module.isUsed(path.node.name);
			if (usedName) {
				path.node.name = usedName;
				// TODO remove this when fixed in @webassemblyjs
				path.node.descr.id = t.numberLiteral(+path.node.descr.id.raw);
			} else {
				path.remove();
			}
		}
	});
};

/**
 * Mangle import names and modules
 * @param {Object} state state
 * @param {Map<string, UsedWasmDependency>} state.usedDependencyMap mappings to mangle names
 * @returns {ArrayBufferTransform} transform
 */
const rewriteImports = ({ usedDependencyMap }) => bin => {
	return edit(bin, {
		ModuleImport(path) {
			const result = usedDependencyMap.get(
				path.node.module + ":" + path.node.name
			);
			if (result === undefined) {
				path.remove();
			} else {
				path.node.module = WebAssemblyUtils.MANGLED_MODULE;
				path.node.name = result.name;
				if (path.node.descr.id)
					path.node.descr.id = t.numberLiteral(+path.node.descr.id.raw);
				if (path.node.descr.name)
					path.node.descr.name = t.numberLiteral(+path.node.descr.name.raw);
			}
		}
	});
};

/**
 * Add an init function.
 *
 * The init function fills the globals given input arguments.
 *
 * @param {Object} state transformation state
 * @param {t.Identifier} state.initFuncId identifier of the init function
 * @param {t.IndexLiteral} state.startAtFuncIndex index of the start function
 * @param {t.ModuleImport[]} state.importedGlobals list of imported globals
 * @param {TODO} state.funcSectionMetadata ??
 * @param {t.IndexLiteral} state.nextFuncIndex index of the next function
 * @param {t.IndexLiteral} state.nextTypeIndex index of the next type
 * @returns {ArrayBufferTransform} transform
 */
const addInitFunction = ({
	initFuncId,
	startAtFuncIndex,
	importedGlobals,
	funcSectionMetadata,
	nextFuncIndex,
	nextTypeIndex
}) => bin => {
	const funcParams = importedGlobals.map(importedGlobal => {
		// used for debugging
		const id = t.identifier(`${importedGlobal.module}.${importedGlobal.name}`);

		return t.funcParam(importedGlobal.descr.valtype, id);
	});

	const funcBody = importedGlobals.reduce((acc, importedGlobal, index) => {
		const args = [t.indexLiteral(index)];
		const body = [
			t.instruction("get_local", args),
			t.instruction("set_global", args)
		];

		return [...acc, ...body];
	}, []);

	if (typeof startAtFuncIndex !== "undefined") {
		funcBody.push(t.callInstruction(startAtFuncIndex));
	}

	const funcResults = [];

	// Code section
	const func = t.func(initFuncId, funcParams, funcResults, funcBody);

	// Type section
	const functype = t.typeInstructionFunc(
		func.signature.params,
		func.signature.results
	);

	// Func section
	const funcindex = t.indexInFuncSection(nextTypeIndex);

	// Export section
	const moduleExport = t.moduleExport(initFuncId.value, "Func", nextFuncIndex);

	return add(bin, [func, moduleExport, funcindex, functype]);
};

/**
 * Extract mangle mappings from module
 * @param {Module} module current module
 * @returns {Map<string, UsedWasmDependency>} mappings to mangled names
 */
const getUsedDependencyMap = module => {
	/** @type {Map<string, UsedWasmDependency>} */
	const map = new Map();
	for (const usedDep of WebAssemblyUtils.getUsedDependencies(module)) {
		const dep = usedDep.dependency;
		const request = dep.request;
		const exportName = dep.name;
		map.set(request + ":" + exportName, usedDep);
	}
	return map;
};

class WebAssemblyGenerator extends Generator {
	generate(module) {
		const bin = module.originalSource().source();

		const initFuncId = t.identifier(
			Array.isArray(module.usedExports)
				? Template.numberToIdentifer(module.usedExports.length)
				: "__webpack_init__"
		);

		// FIXME(sven): this module is parsed twice, we could preserve the AST
		// from wasm/WebAssemblyParser.js
		const ast = decode(bin, {
			ignoreDataSection: true,
			ignoreCodeSection: true
		});

		const importedGlobals = getImportedGlobals(ast);
		const funcSectionMetadata = t.getSectionMetadata(ast, "func");
		const countImportedFunc = getCountImportedFunc(ast);
		const startAtFuncIndex = getStartFuncIndex(ast);
		const nextFuncIndex = getNextFuncIndex(ast, countImportedFunc);
		const nextTypeIndex = getNextTypeIndex(ast);

		const usedDependencyMap = getUsedDependencyMap(module);

		const transform = compose(
			rewriteExportNames({
				module
			}),

			removeStartFunc({}),

			rewriteImportedGlobals({}),

			rewriteImports({
				usedDependencyMap
			}),

			addInitFunction({
				initFuncId,
				importedGlobals,
				funcSectionMetadata,
				startAtFuncIndex,
				nextFuncIndex,
				nextTypeIndex
			})
		);

		const newBin = transform(bin);

		return new RawSource(newBin);
	}
}

module.exports = WebAssemblyGenerator;
