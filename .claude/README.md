# Claude Code compatibility

Crewhelm keeps its shared Agent Skills in `.agents/skills`. The `skills` symlink exposes those
canonical packages at Claude Code's project-skill path without maintaining copies.

The checkout must materialize Git symlinks for Claude Code to discover the skills. On Windows,
enable Developer Mode or use a checkout environment with symlink support before cloning the
repository.
