
# Try to install or update from r-universe.dev
options(warn=2)

repos <- getOption("repos", "https://cloud.r-project.org/")
repos <- gsub("@CRAN@", "https://cloud.r-project.org/", repos)
repos <- c("https://manuelhentschel.r-universe.dev", repos)

install.packages("vscDebugger", repos = repos)
