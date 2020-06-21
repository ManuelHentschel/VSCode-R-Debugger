
gen_data <- function(n) {
  x <- rnorm(n)
  y <- 2 * x
  out <- data.frame(x = x, y = x)
  out
}

calc_stats <- function(x, na.rm = TRUE) {
  qs <- quantile(x, c(0, 0.25, 0.5, 0.75, 1), na.rm = na.rm, names = FALSE)
  data.frame(
    mean = mean(x, na.rm = na.rm),
    sd = sd(x, na.rm = TRUE),
    min = qs[[1]],
    q25 = qs[[2]],
    median = qs[[3]],
    q75 = qs[[4]],
    max = qs[[5]]
  )
}

main <- function() {
  xy_data <- gen_data(100)  ###
  lm_obj <- lm(y ~ x, data = xy_data)
  beta <- coef(lm_obj)
  stats <- lapply(names(xy_data), function(name) {
    cbind(name, calc_stats(xy_data[[name]])) ###
  })
  print(beta)
  print(stats)
}
