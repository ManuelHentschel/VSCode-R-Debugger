repos <- getOption("repos")
if (is.null(repos) || identical(repos, c(CRAN = "@CRAN@"))) {
  options(repos = c(CRAN = "https://cloud.r-project.org/"))
}

url <- commandArgs(trailingOnly = TRUE)[[1]]
install.packages("remotes")
remotes::install_url(url, dependencies = TRUE)
