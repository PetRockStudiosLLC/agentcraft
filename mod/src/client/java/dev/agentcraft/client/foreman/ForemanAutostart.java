package dev.agentcraft.client.foreman;

import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.ClientEnv;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Starts the Foreman when the mod cannot reach one.
 *
 * <p>The Foreman is a separate Node process. Without this, opening the game before starting it
 * leaves the studio empty with no obvious reason why - the HUD just says the link is retrying.
 * So: if the link has not synced after a short grace period, spawn the Foreman once and let the
 * link's normal retry loop pick it up.
 *
 * <p>Started at most once per game session. If it fails (no node, no checkout, port taken) that
 * is logged with the child's own output rather than retried forever - a spawn loop that quietly
 * fills the log is worse than one clear failure.
 *
 * <pre>
 * AGENTCRAFT_AUTOSTART   1 (default) = start the Foreman if the link cannot connect
 * AGENTCRAFT_REPO        the agentcraft checkout (default: the one this jar was built from)
 * AGENTCRAFT_NODE        node executable (default: found under Program Files, else "node" on PATH)
 * AGENTCRAFT_BACKEND     backend for the started Foreman (default: pi)
 * AGENTCRAFT_WORK_REPO   repo the team should work in; omit to add one in-game with /repo add
 * </pre>
 */
public final class ForemanAutostart {
	/** How long to let the link try on its own before starting anything. */
	private static final long GRACE_MS = 4_000L;
	private static final long POLL_MS = 1_000L;
	/** How long to wait before deciding the child died (port taken, bad checkout, ...). */
	private static final long STARTUP_CHECK_MS = 2_500L;

	private static final AtomicBoolean TRIED = new AtomicBoolean(false);
	private static volatile Process child;

	private ForemanAutostart() {
	}

	/** Returns the running Foreman process, or null if we did not start one. */
	public static Process child() {
		return child;
	}

	public static void init(ForemanLink link, int port) {
		if (!ClientEnv.flag("AGENTCRAFT_AUTOSTART", true)) {
			AgentCraft.LOGGER.info("Foreman autostart off (AGENTCRAFT_AUTOSTART=0)");
			return;
		}
		String checkout = ClientEnv.raw("AGENTCRAFT_REPO");
		if (checkout == null || checkout.isBlank()) {
			checkout = bakedRepo();
		}
		if (checkout == null || checkout.isBlank()) {
			AgentCraft.LOGGER.warn("Foreman autostart: no checkout configured - set AGENTCRAFT_REPO to your agentcraft folder");
			return;
		}
		final String repo = checkout;
		final String backend = blankTo(ClientEnv.raw("AGENTCRAFT_BACKEND"), "pi");

		Thread watcher = new Thread(() -> watch(link, repo, backend, port), "agentcraft-autostart");
		watcher.setDaemon(true);
		watcher.start();
	}

	private static void watch(ForemanLink link, String repo, String backend, int port) {
		final long deadline = System.currentTimeMillis() + GRACE_MS;
		for (;;) {
			try {
				Thread.sleep(POLL_MS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
			// A Foreman someone else started (or a reconnect) is not our business.
			if (link.status().synced()) {
				return;
			}
			if (System.currentTimeMillis() < deadline) {
				continue;
			}
			if (!TRIED.compareAndSet(false, true)) {
				return;
			}
			start(repo, backend, port);
			return;
		}
	}

	private static void start(String repo, String backend, int port) {
		File foremanDir = new File(repo, "foreman");
		if (!new File(foremanDir, "src/main.ts").isFile()) {
			AgentCraft.LOGGER.warn("Foreman autostart: '{}' is not an agentcraft checkout (no foreman/src/main.ts)", repo);
			return;
		}

		List<String> cmd = new ArrayList<>();
		cmd.add(nodeExe());
		cmd.add("--import");
		cmd.add("tsx");
		cmd.add("src/main.ts");
		cmd.add("--backend");
		cmd.add(backend);
		cmd.add("--port");
		cmd.add(Integer.toString(port));
		String workRepo = ClientEnv.raw("AGENTCRAFT_WORK_REPO");
		if (workRepo != null && !workRepo.isBlank()) {
			cmd.add("--repo");
			cmd.add(workRepo);
		}

		Path log = logFile();
		ProcessBuilder pb = new ProcessBuilder(cmd);
		pb.directory(foremanDir);
		pb.redirectErrorStream(true);
		if (log != null) {
			pb.redirectOutput(log.toFile());
		}

		try {
			Process p = pb.start();
			child = p;
			AgentCraft.LOGGER.info("Foreman autostart: started `{}` (backend {}, port {})", String.join(" ", cmd), backend, port);
			if (log != null) {
				AgentCraft.LOGGER.info("Foreman autostart: output -> {}", log);
			}
			// It exits almost immediately when the port is taken or node is missing. Say so here,
			// with the child's own output, instead of leaving an empty studio and no explanation.
			p.onExit().thenAccept(proc -> {
				if (proc.exitValue() != 0) {
					AgentCraft.LOGGER.warn("Foreman autostart: exited with code {}. Last output:{}",
						proc.exitValue(), tail(log, 12));
				}
			});
		} catch (IOException e) {
			AgentCraft.LOGGER.warn("Foreman autostart: could not start node ({}). Set AGENTCRAFT_NODE to its full path.", e.toString());
		}
	}

	/** The checkout recorded at build time; blank for a jar built without it. */
	private static String bakedRepo() {
		try (InputStream in = ForemanAutostart.class.getResourceAsStream("/agentcraft-repo.properties")) {
			if (in == null) {
				return null;
			}
			Properties props = new Properties();
			props.load(in);
			return props.getProperty("repoPath");
		} catch (IOException e) {
			return null;
		}
	}

	/**
	 * A bare "node" works only when the launcher's PATH happens to include it, and the failure is
	 * a confusing IOException. Prefer a real install path when one exists.
	 */
	private static String nodeExe() {
		String override = ClientEnv.raw("AGENTCRAFT_NODE");
		if (override != null && !override.isBlank()) {
			return override;
		}
		for (String base : new String[] {System.getenv("ProgramFiles"), System.getenv("ProgramFiles(x86)"), System.getenv("LOCALAPPDATA")}) {
			if (base == null) {
				continue;
			}
			File exe = new File(base, "nodejs/node.exe");
			if (exe.isFile()) {
				return exe.getAbsolutePath();
			}
			exe = new File(base, "Programs/nodejs/node.exe");
			if (exe.isFile()) {
				return exe.getAbsolutePath();
			}
		}
		return "node";
	}

	private static Path logFile() {
		try {
			Path dir = Path.of(System.getProperty("user.home"), ".agentcraft");
			Files.createDirectories(dir);
			return dir.resolve("foreman-autostart.log");
		} catch (Exception e) {
			return null;
		}
	}

	/** Last {@code lines} lines of a log, for a failure report. Best effort. */
	private static String tail(Path log, int lines) {
		if (log == null || !Files.isReadable(log)) {
			return " (no log)";
		}
		try {
			List<String> all = Files.readAllLines(log, StandardCharsets.UTF_8);
			int from = Math.max(0, all.size() - lines);
			StringBuilder sb = new StringBuilder();
			for (String line : all.subList(from, all.size())) {
				sb.append("\n    ").append(line);
			}
			return sb.toString();
		} catch (IOException e) {
			return " (unreadable log)";
		}
	}

	private static String blankTo(String v, String fallback) {
		return v == null || v.isBlank() ? fallback : v;
	}
}
