import * as path from 'path';
import * as ts from 'typescript';
import Uri from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-types';

import { LanguageModelCache } from '../languageModelCache';
import { createUpdater, parseVue, isVue, getFileFsPath, getFilePath } from './preprocess';
import * as bridge from './bridge';

const vueSys: ts.System = {
  ...ts.sys,
  fileExists(path: string) {
    if (path.endsWith('.vue.ts')) {
      return ts.sys.fileExists(path.slice(0, -3));
    }
    return ts.sys.fileExists(path);
  }
};

export function getServiceHost(workspacePath: string, jsDocuments: LanguageModelCache<TextDocument>) {
  let compilerOptions: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    allowJs: true,
    lib: ['lib.dom.d.ts', 'lib.es2017.d.ts'],
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    module: ts.ModuleKind.CommonJS,
    allowSyntheticDefaultImports: true
  };
  let currentScriptDoc: TextDocument;
  const versions = new Map<string, number>();
  const scriptDocs = new Map<string, TextDocument>();

  // Patch typescript functions to insert `import Vue from 'vue'` and `new Vue` around export default.
  // NOTE: Typescript 2.3 should add an API to allow this, and then this code should use that API.
  const { createLanguageServiceSourceFile, updateLanguageServiceSourceFile } = createUpdater();
  (ts as any).createLanguageServiceSourceFile = createLanguageServiceSourceFile;
  (ts as any).updateLanguageServiceSourceFile = updateLanguageServiceSourceFile;
  const configFilename = ts.findConfigFile(workspacePath, ts.sys.fileExists, 'tsconfig.json') ||
    ts.findConfigFile(workspacePath, ts.sys.fileExists, 'jsconfig.json');
  const configJson = configFilename && ts.readConfigFile(configFilename, ts.sys.readFile).config || {
    exclude: ['node_modules', '**/node_modules/*']
  };
  const parsedConfig = ts.parseJsonConfigFileContent(configJson,
    ts.sys,
    workspacePath,
    compilerOptions,
    configFilename,
    undefined,
    [{ extension: 'vue', isMixedContent: true }]);
  const files = parsedConfig.fileNames;
  compilerOptions = parsedConfig.options;
  compilerOptions.allowNonTsExtensions = true;

  function updateCurrentTextDocument (doc: TextDocument) {
    const fileFsPath = getFileFsPath(doc.uri);
    const filePath = getFilePath(doc.uri);
    // When file is not in language service, add it
    if (!scriptDocs.has(fileFsPath)) {
      if (fileFsPath.endsWith('.vue')) {
        files.push(filePath);
      }
    }
    if (!currentScriptDoc || doc.uri !== currentScriptDoc.uri || doc.version !== currentScriptDoc.version) {
      currentScriptDoc = jsDocuments.get(doc);
      const lastDoc = scriptDocs.get(fileFsPath);
      if (lastDoc && currentScriptDoc.languageId !== lastDoc.languageId) {
        // if languageId changed, restart the language service; it can't handle file type changes
        jsLanguageService.dispose();
        jsLanguageService = ts.createLanguageService(host);
      }
      scriptDocs.set(fileFsPath, currentScriptDoc);
      versions.set(fileFsPath, (versions.get(fileFsPath) || 0) + 1);
    }
    return {
      service: jsLanguageService,
      scriptDoc: currentScriptDoc
    };
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => files,
    getScriptVersion (fileName) {
      if (fileName === bridge.fileName) {
        return '0';
      }
      const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
      const version = versions.get(normalizedFileFsPath);
      return version ? version.toString() : '0';
    },
    getScriptKind (fileName) {
      if (isVue(fileName)) {
        const uri = Uri.file(fileName);
        fileName = uri.fsPath;
        const doc = scriptDocs.get(fileName) ||
          jsDocuments.get(TextDocument.create(uri.toString(), 'vue', 0, ts.sys.readFile(fileName)));
        return doc.languageId === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
      }
      else {
        if (fileName === bridge.fileName) {
          return ts.Extension.Ts;
        }
        // NOTE: Typescript 2.3 should export getScriptKindFromFileName. Then this cast should be removed.
        return (ts as any).getScriptKindFromFileName(fileName);
      }
    },

    // resolve @types, see https://github.com/Microsoft/TypeScript/issues/16772
    getDirectories: ts.sys.getDirectories,
    directoryExists: ts.sys.directoryExists,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,

    resolveModuleNames (moduleNames: string[], containingFile: string): ts.ResolvedModule[] {
      // in the normal case, delegate to ts.resolveModuleName
      // in the relative-imported.vue case, manually build a resolved filename
      return moduleNames.map(name => {
        if (name === bridge.moduleName) {
          return {
            resolvedFileName: bridge.fileName,
            extension: ts.Extension.Ts
          };
        }
        if (path.isAbsolute(name) || !isVue(name)) {
          return ts.resolveModuleName(name, containingFile, compilerOptions, ts.sys).resolvedModule!;
        }
        const resolved = ts.resolveModuleName(name, containingFile, compilerOptions, vueSys).resolvedModule;
        if (!resolved) {
          return undefined as any;
        }
        const resolvedFileName = resolved.resolvedFileName.slice(0, -3);
        const uri = Uri.file(resolvedFileName);
        const doc = scriptDocs.get(resolvedFileName) ||
          jsDocuments.get(TextDocument.create(uri.toString(), 'vue', 0, ts.sys.readFile(resolvedFileName)));
        return {
          resolvedFileName,
          extension: doc.languageId === 'typescript' ? ts.Extension.Ts : ts.Extension.Js,
        };
      });
    },
    getScriptSnapshot: (fileName: string) => {
      if (fileName === bridge.fileName) {
        const text = bridge.content;
        return {
          getText: (start, end) => text.substring(start, end),
          getLength: () => text.length,
          getChangeRange: () => void 0
        };
      }
      const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
      const doc = scriptDocs.get(normalizedFileFsPath);
      let text = doc ? doc.getText() : (ts.sys.readFile(normalizedFileFsPath) || '');
      if (!doc && isVue(fileName)) {
        // Note: This is required in addition to the parsing in embeddedSupport because
        // this works for .vue files that aren't even loaded by VS Code yet.
        text = parseVue(text);
      }
      return {
        getText: (start, end) => text.substring(start, end),
        getLength: () => text.length,
        getChangeRange: () => void 0
      };
    },
    getCurrentDirectory: () => workspacePath,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
  };

  let jsLanguageService = ts.createLanguageService(host);
  return {
    updateCurrentTextDocument,
    getService: () => jsLanguageService
  };
}

function getNormalizedFileFsPath (fileName: string): string {
  return Uri.file(fileName).fsPath;
}
