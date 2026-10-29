package com.keepyourprompts

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Duration

/** Compiled and run with `mvn -Pkotlin verify`: the Java API as a Kotlin app would use it. */
class KotlinUsageTest {
    private val v12: Path = Paths.get(System.getProperty("kyp.conformance.dir") ?: "../conformance", "fixtures", "v12")

    @Test
    fun `reads and renders from Kotlin`() {
        val updates = mutableListOf<Update>()
        KeepYourPrompts.builder()
            .app("demo")
            .env("prod")
            .snapshotDir(v12)
            .pollInterval(Duration.ofSeconds(30))
            .logLevel(LogLevel.OFF)
            .onUpdate { updates += it }
            .build()
            .use { prompts ->
                val text = prompts.render("greeting", mapOf("name" to "Ana", "company" to "Acme"))
                assertEquals("Hello Ana, welcome to Acme.", text)

                val p: Prompt = prompts.prompt("greeting")
                assertEquals(4L, p.version())
                assertEquals(listOf("name", "company"), p.variables())

                assertEquals(null, prompts.tryGet("missing").orElse(null))
                val status = prompts.status()
                assertTrue(status.ready())
                assertEquals("snapshot", status.source())

                val missing = runCatching { prompts.render("greeting", emptyMap<String, Any>()) }.exceptionOrNull()
                assertTrue(missing is MissingVariableException)
            }
        assertTrue(updates.isEmpty())
    }
}
