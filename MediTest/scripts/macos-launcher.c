#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void)
{
    char executablePath[PATH_MAX];
    uint32_t executablePathSize = sizeof(executablePath);
    if (_NSGetExecutablePath(executablePath, &executablePathSize) != 0) {
        fputs("Meduvalo konnte seinen Installationspfad nicht bestimmen.\n", stderr);
        return 1;
    }

    char resolvedPath[PATH_MAX];
    if (realpath(executablePath, resolvedPath) == NULL) {
        perror("realpath");
        return 1;
    }

    char *macosDirectory = strrchr(resolvedPath, '/');
    if (macosDirectory == NULL) {
        fputs("Meduvalo-Appstruktur ist ungueltig.\n", stderr);
        return 1;
    }
    *macosDirectory = '\0';

    char appDirectory[PATH_MAX];
    char appExecutable[PATH_MAX];
    if (snprintf(appDirectory, sizeof(appDirectory), "%s/../Resources/app", resolvedPath) >= (int)sizeof(appDirectory) ||
        snprintf(appExecutable, sizeof(appExecutable), "%s/MediTest", appDirectory) >= (int)sizeof(appExecutable)) {
        fputs("Meduvalo-Installationspfad ist zu lang.\n", stderr);
        return 1;
    }

    if (chdir(appDirectory) != 0) {
        perror("chdir");
        return 1;
    }

    setenv("ASPNETCORE_URLS", "http://127.0.0.1:55000", 0);
    setenv("DOTNET_URLS", "http://127.0.0.1:55000", 0);
    execl(appExecutable, appExecutable, (char *)NULL);

    perror("Meduvalo starten");
    return 1;
}
