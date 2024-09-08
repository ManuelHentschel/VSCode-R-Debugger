
# This script tries to install the vscDebugger package from various sources.
# Uses lots of `try()` calls to have the highest chance of success.
# Intended for new users, who are not familiar with R package installation.


## Repos setup ("@CRAN@" in options might need to be replaced by a default mirror URL)
repos <- getOption("repos", "https://cloud.r-project.org/")
repos <- gsub("@CRAN@", "https://cloud.r-project.org/", repos)
options(repos = repos)


## Install dependencies
cat('Installing dependencies: jsonlite, R6...\n')
install.packages(c("jsonlite", "R6"))



## Install vscDebugger
# Exit if package already installed
if('vscDebugger' %in% rownames(installed.packages())) {
  cat('\nPackage vscDebugger already installed. Remove it manually to force reinstall.\n')
  quit(save = 'no', status = 1)
}

# Helper function to exit after successful installation
exit_if_ok <- function(...) {
  if('vscDebugger' %in% rownames(installed.packages())) {
    cat('\nPackage vscDebugger installed successfully.\n', ...)
    quit(save = 'no', status = 0)
  }
}


# Try to install from r-universe.dev
cat('\nInstalling vscDebugger from r-universe.dev...\n')
try(install.packages("vscDebugger", repos = "https://manuelhentschel.r-universe.dev"))
exit_if_ok()
warning('Installing from r-universe.dev failed!')


# Install remotes package if not already installed
remotes_installed <- function() ('remotes' %in% rownames(installed.packages()))
if(!remotes_installed()) {
  cat('Package `remotes` not installed, trying to install it...\n')
  try(install.packages("remotes"))
}

# Try remotes package if available
if(remotes_installed()) {
  cat('\nInstalling vscDebugger from GitHub...\n')
  try(remotes::install_github("ManuelHentschel/vscDebugger"))
  exit_if_ok()
  warning('Installing from GitHub failed!')
} else {
  warning('Installing package `remotes` failed! Skipping installation from GitHub.\n')
}


# Try from GitHub action artifact
cat('\nInstalling vscDebugger from GitHub action artifact...\n')
url <- commandArgs(trailingOnly = TRUE)[[1]]
try(install.packages(url, repos = NULL))
exit_if_ok('A newer version might be available on GitHub.\n')
warning('Installing from GitHub action artifact failed!')


# Only reached if all installation attempts failed
stop('Installation failed. Make sure the pacakge is not loaded in any R session, or try installing manually.')
