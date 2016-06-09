package controllers

import discussion.model.DiscussionKey
import model.Cached
import common.JsonComponent
import play.api.libs.json.{JsArray, JsObject}
import play.api.mvc.Action

object CommentCountController extends DiscussionController {

  def commentCountJson(shortUrls: String) = commentCount(shortUrls)

  def commentCountForBlocksJson(shortUrls: String) = commentCountForBlocks(shortUrls)

  def commentCount(shortUrls: String) = Action.async {
    implicit request =>
      val counts = discussionApi.commentCounts(shortUrls)
      counts map {
        counts =>
          Cached(300) {
            JsonComponent(
              JsObject(Seq("counts" -> JsArray(counts.map(_.toJson))))
            )
          }
      }
  }

  def commentCountForBlocks(shortUrl: String) = Action.async {
    implicit request =>
      val counts = discussionApi.commentCountsForBlocks(DiscussionKey(shortUrl))
      counts map {
        counts =>
          Cached(300) {
            JsonComponent(
              JsObject(Seq("counts" -> JsArray(counts.map(_.toJson))))
            )
          }
      }
  }

}
