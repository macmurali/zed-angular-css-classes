use std::{env, fs};

use zed_extension_api::{
    self as zed, serde_json, settings::LspSettings, LanguageServerId, Result,
};

/// The language server is a single dependency-free Node script. It is embedded
/// at compile time and written into the extension's working directory, then run
/// with the Node binary that Zed already manages.
const SERVER_SOURCE: &str = include_str!("../server/angular-css-lsp.js");
const SERVER_FILE: &str = "angular-css-lsp.js";
const SERVER_NAME: &str = "angular-css-classes";

struct AngularCssClassesExtension {
    server_written: bool,
}

impl AngularCssClassesExtension {
    fn server_script_path(&mut self) -> Result<String> {
        if !self.server_written {
            let up_to_date = fs::read_to_string(SERVER_FILE)
                .map(|existing| existing == SERVER_SOURCE)
                .unwrap_or(false);
            if !up_to_date {
                fs::write(SERVER_FILE, SERVER_SOURCE)
                    .map_err(|e| format!("failed to write {SERVER_FILE}: {e}"))?;
            }
            self.server_written = true;
        }
        let dir = env::current_dir().map_err(|e| format!("no working directory: {e}"))?;
        Ok(dir.join(SERVER_FILE).to_string_lossy().into_owned())
    }
}

impl zed::Extension for AngularCssClassesExtension {
    fn new() -> Self {
        Self {
            server_written: false,
        }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(SERVER_NAME, worktree)
            .ok()
            .and_then(|s| s.binary);

        // Escape hatch: `lsp.angular-css-classes.binary.path` in settings.json
        // lets you run a different build of the server (e.g. while hacking on it).
        if let Some(path) = binary.as_ref().and_then(|b| b.path.clone()) {
            return Ok(zed::Command {
                command: path,
                args: binary
                    .as_ref()
                    .and_then(|b| b.arguments.clone())
                    .unwrap_or_default(),
                env: binary
                    .and_then(|b| b.env)
                    .map(|env| env.into_iter().collect())
                    .unwrap_or_default(),
            });
        }

        let script = self.server_script_path()?;
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![script, "--stdio".into()],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(LspSettings::for_worktree(SERVER_NAME, worktree)
            .ok()
            .and_then(|s| s.initialization_options))
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(LspSettings::for_worktree(SERVER_NAME, worktree)
            .ok()
            .and_then(|s| s.settings))
    }
}

zed::register_extension!(AngularCssClassesExtension);
