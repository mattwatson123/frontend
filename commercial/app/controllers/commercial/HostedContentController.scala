package controllers.commercial

import common.commercial.HostedPage
import model.Cached.RevalidatableResult
import model.{Cached, NoCache}
import play.api.mvc.{Action, Controller}
import views.html.hosted.guardianHostedVideo

object HostedContentController extends Controller {

  def renderHostedPage(pageName: String) = Action { implicit request =>
    HostedPage.fromPageName(pageName) match {
      case Some(page) => Cached(60)(RevalidatableResult.Ok(guardianHostedVideo(page)))
      case None => NoCache(NotFound)
    }
  }
}
