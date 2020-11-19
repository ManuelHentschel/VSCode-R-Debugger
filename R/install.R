repos <- getOption("repos")
if (is.null(repos) || identical(repos, c(CRAN = "@CRAN@"))) {
  repos <- c(CRAN = "https://cloud.r-project.org/")
}

url <- commandArgs(trailingOnly = TRUE)[[1]]
install.packages(c("jsonlite", "R6"), repos = repos)
install.packages(url, repos = NULL)
