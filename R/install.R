repos <- getOption("repos")
if (is.null(repos) || identical(repos, c(CRAN = "@CRAN@"))) {
  options(repos = c(CRAN = "https://cloud.r-project.org/"))
}

install.packages(c("jsonlite", "R6"))

url <- commandArgs(trailingOnly = TRUE)[[1]]
install.packages(url, repos = NULL)
