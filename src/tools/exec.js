// Barrel re-export — keeps backward-compatible imports while the real
// implementations live in focused sub-modules:
//
//   src/tools/file-read.js   — read_file, list_dir, grep_search, find_files
//   src/tools/file-write.js  — write_file, str_replace_in_file, apply_patch
//   src/tools/shell.js       — run_shell
//   src/tools/web-search.js  — web_search
//   src/tools/fetch-top.js   — fetch_top
//   src/tools/utils.js       — truncate, ensurePathAllowed (shared helpers)
//
// To add a new tool: create a new sub-module and re-export it here, then
// register it in ToolExecutor (src/chat/tool-executor.js).
'use strict';

const { toolReadFile, toolListDir, toolGrepSearch, toolFindFiles,
        toolGetDiagnostics }                                       = require('./file-read');
const { toolWriteFile, toolStrReplaceInFile, toolApplyPatch }     = require('./file-write');
const { toolRunShell, isDangerous }                               = require('./shell');
const { toolRunShellBg }                                          = require('./bg-shell');
const { toolReadTerminal }                                        = require('./read-terminal');
const { toolWebSearch }                                           = require('./web-search');
const { toolWebFetch }                                            = require('./web-fetch');
const { toolFetchTop }                                            = require('./fetch-top');
const { toolSavePlan }                                            = require('./save-plan');
const { truncate }                                                = require('./utils');
const { toolGetEditorContext }                                    = require('./editor-context');
const { toolGitStatus, toolGitDiff, toolGitLog }                  = require('./git');
const { toolDiffFiles }                                          = require('./diff-files');
const { toolFindReferences, toolGoToDefinition }                  = require('./lsp');
const { toolMemoryRead, toolMemoryWrite }                         = require('./memory');

module.exports = {
    toolReadFile,
    toolListDir,
    toolGrepSearch,
    toolFindFiles,
    toolGetDiagnostics,
    toolWriteFile,
    toolStrReplaceInFile,
    toolApplyPatch,
    toolRunShell,
    toolRunShellBg,
    toolReadTerminal,
    toolWebSearch,
    toolWebFetch,
    toolFetchTop,
    toolSavePlan,
    truncate,
    isDangerous,
    toolGetEditorContext,
    toolGitStatus,
    toolGitDiff,
    toolGitLog,
    toolDiffFiles,
    toolFindReferences,
    toolGoToDefinition,
    toolMemoryRead,
    toolMemoryWrite,
};
